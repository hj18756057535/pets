//! Deterministic, offline masking. No source text or rule is persisted or logged.
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs, io::{Cursor, Write}, path::Path};
use calamine::{Data, Reader, Xlsx};

pub const MAX_FILE: usize = 20 * 1024 * 1024;
const MAX_TEXT: usize = 2 * 1024 * 1024;
const MAX_ROWS: usize = 50_000;
const MAX_COLS: usize = 128;
const MAX_CELLS: usize = 200_000;

#[derive(Clone, Deserialize, Serialize)]
pub struct Keyword { pub find: String, pub replace: String }

#[derive(Clone, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum Rule {
    Mask { head: usize, tail: usize },
    Replace { value: String },
    Keywords { rules: Vec<Keyword> },
}

#[derive(Clone, Deserialize)]
pub struct ColumnRule { pub column: usize, pub rule: Rule }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextResult { pub text: String, pub matches: usize }

pub fn validate_keywords(rules: &[Keyword]) -> Result<(), String> {
    if rules.is_empty() || rules.len() > 100 { return Err("请设置 1～100 条关键词规则".into()); }
    let mut seen = HashSet::new();
    for rule in rules {
        if rule.find.is_empty() || rule.find.len() > 4096 || rule.replace.len() > 4096 {
            return Err("关键词不能为空，每项关键词或替换值不能超过 4096 字节".into());
        }
        if !seen.insert(&rule.find) { return Err("存在重复关键词，请合并后重试".into()); }
    }
    Ok(())
}

pub fn replace_keywords(text: &str, rules: &[Keyword]) -> Result<TextResult, String> {
    validate_keywords(rules)?;
    if text.len() > MAX_TEXT { return Err("单次文本不能超过 2 MiB".into()); }
    let mut sorted: Vec<_> = rules.iter().collect();
    sorted.sort_by_key(|r| std::cmp::Reverse(r.find.len()));
    let mut output = String::new();
    let mut rest = text;
    let mut matches = 0;
    while !rest.is_empty() {
        if let Some(rule) = sorted.iter().find(|r| rest.starts_with(&r.find)) {
            output.push_str(&rule.replace);
            rest = &rest[rule.find.len()..];
            matches += 1;
        } else {
            let ch = rest.chars().next().unwrap();
            output.push(ch);
            rest = &rest[ch.len_utf8()..];
        }
        if output.len() > MAX_TEXT { return Err("替换后的文本超过 2 MiB，请缩小输入或替换值".into()); }
    }
    Ok(TextResult { text: output, matches })
}

impl Rule {
    fn validate(&self) -> Result<(), String> {
        match self {
            Self::Mask { head, tail } if *head > 100 || *tail > 100 => Err("首尾保留数量必须在 0～100 之间".into()),
            Self::Replace { value } if value.len() > 4096 => Err("替换值不能超过 4096 字节".into()),
            Self::Keywords { rules } => validate_keywords(rules),
            _ => Ok(()),
        }
    }
    pub fn apply(&self, value: &str) -> Result<String, String> {
        self.validate()?;
        if value.is_empty() { return Ok(String::new()); }
        match self {
            Self::Mask { head, tail } => {
                let chars: Vec<_> = value.chars().collect();
                if chars.len() <= head + tail { return Ok("****".into()); }
                Ok(format!("{}****{}", chars[..*head].iter().collect::<String>(), chars[chars.len()-tail..].iter().collect::<String>()))
            }
            Self::Replace { value } => Ok(value.clone()),
            Self::Keywords { rules } => Ok(replace_keywords(value, rules)?.text),
        }
    }
}

#[derive(Clone)]
pub struct Sheet { pub rows: Vec<Vec<String>>, pub width: usize, pub first_row: usize }

impl Sheet {
    fn checked(rows: Vec<Vec<String>>, first_row: usize) -> Result<Self, String> {
        let width = rows.iter().map(Vec::len).max().unwrap_or(0);
        check_size(rows.len(), width)?;
        if rows.iter().flatten().map(String::len).sum::<usize>() > 32 * 1024 * 1024 {
            return Err("工作表文本总量超过 32 MiB".into());
        }
        Ok(Self { rows, width, first_row })
    }
}

fn check_size(rows: usize, cols: usize) -> Result<(), String> {
    if rows > MAX_ROWS || cols > MAX_COLS || rows.saturating_mul(cols) > MAX_CELLS {
        Err("工作表超过首版限制：50,000 行、128 列或 200,000 个单元格".into())
    } else { Ok(()) }
}

pub struct Source { bytes: Vec<u8>, csv: bool, pub names: Vec<String> }
impl Source {
    pub fn from_bytes(bytes: Vec<u8>, extension: &str) -> Result<Self, String> {
        if bytes.len() > MAX_FILE { return Err("文件不能超过 20 MiB".into()); }
        let csv = extension.eq_ignore_ascii_case("csv");
        let names = if csv {
            vec!["CSV".into()]
        } else if extension.eq_ignore_ascii_case("xlsx") {
            let mut archive = zip::ZipArchive::new(Cursor::new(&bytes)).map_err(|_| "无法读取 XLSX 压缩结构")?;
            let mut size = 0u64;
            for i in 0..archive.len() {
                size = size.saturating_add(archive.by_index(i).map_err(|_| "无效的 XLSX 文件")?.size());
                if size > 100 * 1024 * 1024 { return Err("XLSX 解压内容超过 100 MiB".into()); }
            }
            let book: Xlsx<_> = Xlsx::new(Cursor::new(&bytes)).map_err(|_| "无法读取 XLSX，请确认文件未加密且格式正确")?;
            book.sheet_names()
        } else { return Err("首版支持 .xlsx 和 UTF-8 .csv 文件".into()); };
        if names.is_empty() { return Err("文件中没有工作表".into()); }
        Ok(Self { bytes, csv, names })
    }

    pub fn read(&self, index: usize) -> Result<Sheet, String> {
        let name = self.names.get(index).ok_or("工作表不存在")?;
        if self.csv {
            let text = std::str::from_utf8(&self.bytes).map_err(|_| "CSV 必须使用 UTF-8 编码，请在 Excel 中另存为 CSV UTF-8")?;
            let mut reader = csv::ReaderBuilder::new().has_headers(false).flexible(true).from_reader(text.trim_start_matches('\u{feff}').as_bytes());
            let mut rows = Vec::new();
            let mut width = 0;
            for record in reader.records() {
                let record = record.map_err(|_| "CSV 结构无效，请检查引号和分隔符")?;
                width = width.max(record.len());
                check_size(rows.len() + 1, width)?;
                rows.push(record.iter().map(str::to_owned).collect());
            }
            return Sheet::checked(rows, 0);
        }
        let mut book: Xlsx<_> = Xlsx::new(Cursor::new(&self.bytes)).map_err(|_| "无法读取 XLSX")?;
        let range = book.worksheet_range(name).map_err(|_| "无法读取工作表，可能已损坏或超出可处理范围")?;
        let (start_row, start_col) = range.start().unwrap_or((0, 0));
        check_size(range.height(), range.width() + start_col as usize)?;
        let mut rows = Vec::new();
        for row in range.rows() {
            let mut values = vec![String::new(); start_col as usize];
            for cell in row {
                values.push(match cell {
                    Data::DateTime(value) => value.as_datetime().map(|v| v.to_string()).unwrap_or_else(|| value.to_string()),
                    Data::Empty => String::new(),
                    _ => cell.to_string(),
                });
            }
            rows.push(values);
        }
        Sheet::checked(rows, start_row as usize)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub before: Vec<Vec<String>>, pub after: Vec<Vec<String>>,
    pub changed_cells: usize, pub row_count: usize, pub width: usize,
    pub first_row: usize, pub preview_id: String,
}
pub struct Prepared { pub rows: Vec<Vec<String>>, pub preview: Preview }

pub fn prepare(sheet: &Sheet, columns: &[ColumnRule], header: bool) -> Result<Prepared, String> {
    if columns.is_empty() { return Err("请至少选择一列进行脱敏".into()); }
    let mut seen = HashSet::new();
    for column in columns {
        if column.column >= sheet.width || !seen.insert(column.column) { return Err("列选择无效或重复".into()); }
        column.rule.validate()?;
    }
    let mut rows = sheet.rows.clone();
    let mut changed = 0;
    let mut bytes = 0usize;
    for (index, row) in rows.iter_mut().enumerate() {
        if !(header && index == 0) {
            for column in columns {
                if let Some(value) = row.get_mut(column.column) {
                    let masked = column.rule.apply(value)?;
                    if *value != masked { changed += 1; *value = masked; }
                }
            }
        }
        for value in row.iter() {
            if value.chars().count() > 32767 { return Err("单元格内容超过 Excel 的 32,767 字符限制，请缩短后重试".into()); }
            bytes = bytes.saturating_add(value.len());
        }
        if bytes > 32 * 1024 * 1024 { return Err("脱敏结果超过 32 MiB".into()); }
    }
    let preview = Preview {
        before: sheet.rows.iter().take(20).cloned().collect(),
        after: rows.iter().take(20).cloned().collect(), changed_cells: changed,
        row_count: rows.len(), width: sheet.width, first_row: sheet.first_row,
        preview_id: uuid::Uuid::new_v4().to_string(),
    };
    Ok(Prepared { rows, preview })
}

pub fn xlsx_bytes(rows: &[Vec<String>]) -> Result<Vec<u8>, String> {
    let mut workbook = rust_xlsxwriter::Workbook::new();
    let sheet = workbook.add_worksheet();
    sheet.set_name("脱敏数据").map_err(|_| "无法创建输出工作表")?;
    for (r, row) in rows.iter().enumerate() {
        for (c, value) in row.iter().enumerate() {
            // Explicit string cells never become formulas, hyperlinks or numbers.
            sheet.write_string(r as u32, c as u16, value).map_err(|_| "无法写入单元格，请检查内容长度")?;
        }
    }
    workbook.save_to_buffer().map_err(|_| "生成 Excel 文件失败".into())
}

pub fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    // create_new rejects existing files, links and the source, without a TOCTOU overwrite.
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(path)
        .map_err(|_| "无法创建文件：请选择不存在的新文件名，并确认目录可写")?;
    file.write_all(bytes).and_then(|_| file.sync_all())
        .map_err(|_| "写入失败，目标文件可能不完整，请换一个新文件名重试".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn keyword(find: &str, replace: &str) -> Keyword { Keyword { find: find.into(), replace: replace.into() } }
    #[test]
    fn keywords_are_longest_first_literal_and_non_cascading() {
        let result = replace_keywords("张三丰 张三 A .*", &[keyword("张三", "人"), keyword("张三丰", "A"), keyword("A", "B"), keyword(".*", "字面")]).unwrap();
        assert_eq!(result.text, "A 人 B 字面");
        assert_eq!(result.matches, 4);
        assert!(replace_keywords("x", &[keyword("", "x")]).is_err());
        assert!(replace_keywords("x", &[keyword("x", "a"), keyword("x", "b")]).is_err());
    }
    #[test]
    fn masking_handles_unicode_short_and_empty_values() {
        let rule = Rule::Mask { head: 1, tail: 1 };
        assert_eq!(rule.apply("张小明").unwrap(), "张****明");
        assert_eq!(rule.apply("😊你好🌸").unwrap(), "😊****🌸");
        assert_eq!(rule.apply("张三").unwrap(), "****");
        assert_eq!(rule.apply("").unwrap(), "");
        assert_eq!(Rule::Mask { head: 0, tail: 0 }.apply("秘密").unwrap(), "****");
        assert!(Rule::Mask { head: usize::MAX, tail: 1 }.apply("abc").is_err());
    }
    #[test]
    fn csv_and_column_rules_keep_headers_empty_cells_and_leading_zeroes() {
        let source = Source::from_bytes("\u{feff}编号,姓名,备注\r\n00123,张小明,\"第一行\n第二行\"\r\n00124,,\"a,b\"".as_bytes().to_vec(), "csv").unwrap();
        let sheet = source.read(0).unwrap();
        let result = prepare(&sheet, &[ColumnRule { column: 1, rule: Rule::Mask { head: 1, tail: 0 } }], true).unwrap();
        assert_eq!(result.rows[0][1], "姓名");
        assert_eq!(result.rows[1], ["00123", "张****", "第一行\n第二行"]);
        assert_eq!(result.rows[2][1], "");
        assert_eq!(result.preview.changed_cells, 1);
        assert!(Source::from_bytes(vec![0xff], "csv").unwrap().read(0).is_err());
        assert!(prepare(&sheet, &[], true).is_err());
    }
    #[test]
    fn xlsx_exports_only_selected_values_and_never_formulas() {
        let mut book = rust_xlsxwriter::Workbook::new();
        book.add_worksheet().set_name("客户").unwrap().write_string(2, 1, "姓名").unwrap().write_string(3, 1, "张小明").unwrap();
        book.add_worksheet().set_name("秘密").unwrap().write_string(0, 0, "不应导出").unwrap();
        let source = Source::from_bytes(book.save_to_buffer().unwrap(), "xlsx").unwrap();
        assert_eq!(source.names.len(), 2);
        let sheet = source.read(0).unwrap();
        assert_eq!(sheet.first_row, 2);
        let mut result = prepare(&sheet, &[ColumnRule { column: 1, rule: Rule::Replace { value: "=1+1".into() } }], true).unwrap();
        result.rows.push(vec!["00123".into(), "https://example.com".into()]);
        let bytes = xlsx_bytes(&result.rows).unwrap();
        let mut exported: Xlsx<_> = Xlsx::new(Cursor::new(&bytes)).unwrap();
        assert_eq!(exported.sheet_names(), ["脱敏数据"]);
        assert!(exported.worksheet_formula("脱敏数据").unwrap().is_empty());
        let restored = Source::from_bytes(bytes, "xlsx").unwrap().read(0).unwrap();
        assert_eq!(restored.rows[1][1], "=1+1");
        assert_eq!(restored.rows[2][0], "00123");
    }
    #[test]
    fn limits_and_no_overwrite() {
        assert!(check_size(MAX_ROWS + 1, 1).is_err());
        assert!(check_size(2000, MAX_COLS).is_err());
        assert!(Source::from_bytes(Vec::new(), "xls").is_err());
        let path = std::env::temp_dir().join(format!("maskdesk-test-{}.xlsx", uuid::Uuid::new_v4()));
        write_new(&path, b"original").unwrap();
        assert!(write_new(&path, b"changed").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original");
        fs::remove_file(path).unwrap();
    }
}
