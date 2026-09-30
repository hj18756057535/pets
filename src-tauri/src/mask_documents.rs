//! Clean text extraction and fresh DOCX creation; never copy original package parts.
use std::io::{Cursor, Read, Write};
use quick_xml::{events::Event, name::ResolveResult, reader::NsReader};
const MAX_TEXT: usize = 2 * 1024 * 1024;
const WORD_NS: &[u8] = b"http://schemas.openxmlformats.org/wordprocessingml/2006/main";

pub fn output_name(source: &str, detail: &str, extension: &str) -> String {
    let stem = std::path::Path::new(source).file_stem().and_then(|s| s.to_str()).unwrap_or("文本");
    let clean = |s: &str, limit: usize| s.chars().map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c }).take(limit).collect::<String>();
    let detail = if detail.is_empty() { String::new() } else { format!("_{}", clean(detail, 30)) };
    format!("{}{}_脱敏_{}.{}", clean(stem, 80), detail, chrono::Local::now().format("%Y%m%d-%H%M%S-%3f"), extension)
}

pub fn read(bytes: &[u8], extension: &str) -> Result<String, String> {
    if bytes.len() > crate::masking::MAX_FILE { return Err("文件超过 20 MiB".into()); }
    let text = match extension.to_ascii_lowercase().as_str() {
        "txt" => decode_txt(bytes)?,
        "docx" => {
            let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "不是有效的 DOCX，旧版 .doc 请先另存为 .docx")?;
            if zip.len() > 10000 || (0..zip.len()).try_fold(0u64, |sum, i| zip.by_index(i).ok().and_then(|f| sum.checked_add(f.size()))).unwrap_or(u64::MAX) > 100 * 1024 * 1024 {
                return Err("Word 解压内容超过限制".into());
            }
            let mut text = String::new();
            let mut names: Vec<_> = zip.file_names().filter(|n| {
                *n == "word/document.xml" || *n == "word/footnotes.xml" || *n == "word/endnotes.xml" ||
                (n.starts_with("word/header") || n.starts_with("word/footer")) && n.ends_with(".xml")
            }).map(str::to_owned).collect();
            if !names.iter().any(|n| n == "word/document.xml") { return Err("DOCX 缺少正文".into()); }
            names.sort_by_key(|n| (n != "word/document.xml", n.clone()));
            for name in names {
                let mut xml = String::new();
                zip.by_name(&name).map_err(|_| "Word 内容不可读")?.take(16 * 1024 * 1024 + 1).read_to_string(&mut xml).map_err(|_| "Word XML 编码无效")?;
                if xml.len() > 16 * 1024 * 1024 { return Err("Word 单个文本部分过大".into()); }
                let part = extract_xml(&xml)?;
                if !part.trim().is_empty() {
                    if name != "word/document.xml" { text.push_str("\n[附加文字：页眉 / 页脚 / 脚注 / 尾注]\n"); }
                    text.push_str(&part);
                }
                if text.len() > MAX_TEXT { return Err("提取文字超过 2 MiB".into()); }
            }
            text
        }
        _ => return Err("仅支持 .docx 和 .txt；旧版 .doc 请先另存为 .docx".into()),
    };
    if text.len() > MAX_TEXT { return Err("提取文字超过 2 MiB".into()); }
    Ok(text)
}

fn decode_txt(bytes: &[u8]) -> Result<String, String> {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        if bytes.len() % 2 != 0 { return Err("UTF-16 文件长度无效".into()); }
        let little = bytes[0] == 0xff;
        let units: Vec<_> = bytes[2..].chunks_exact(2).map(|c| if little { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) }).collect();
        String::from_utf16(&units).map_err(|_| "UTF-16 文本无效".into())
    } else {
        String::from_utf8(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes).to_vec()).map_err(|_| "TXT 请先另存为 UTF-8 或带 BOM 的 UTF-16 编码".into())
    }
}

fn extract_xml(xml: &str) -> Result<String, String> {
    let mut reader = NsReader::from_str(xml);
    let mut output = String::new();
    let mut in_text = false;
    let mut deleted = 0usize;
    loop {
        let (namespace, event) = reader.read_resolved_event().map_err(|_| "Word XML 损坏")?;
        let word = matches!(namespace, ResolveResult::Bound(ns) if ns.as_ref() == WORD_NS || ns.as_ref() == b"http://purl.oclc.org/ooxml/wordprocessingml/main");
        match event {
            Event::Start(e) if word => match e.local_name().as_ref() {
                b"del" | b"moveFrom" => deleted += 1,
                b"t" if deleted == 0 => in_text = true,
                b"altChunk" => return Err("此 Word 含嵌入正文，请在 Word 中转为普通段落后重试".into()),
                _ => (),
            },
            Event::Empty(e) if word && deleted == 0 => match e.local_name().as_ref() {
                b"tab" => output.push('\t'), b"br" | b"cr" => output.push('\n'),
                b"altChunk" => return Err("此 Word 含嵌入正文，请在 Word 中转为普通段落后重试".into()),
                _ => (),
            },
            Event::End(e) if word => match e.local_name().as_ref() {
                b"del" | b"moveFrom" => deleted = deleted.saturating_sub(1),
                b"t" => in_text = false,
                b"p" if deleted == 0 => output.push('\n'),
                b"tc" if deleted == 0 => output.push('\t'),
                _ => (),
            },
            Event::Text(e) if in_text => output.push_str(&e.decode().map_err(|_| "Word 文字编码无效")?),
            Event::CData(e) if in_text => output.push_str(&e.decode().map_err(|_| "Word 文字编码无效")?),
            Event::GeneralRef(e) if in_text => {
                if let Some(ch) = e.resolve_char_ref().map_err(|_| "Word 字符引用无效")? { output.push(ch); }
                else {
                    let name = e.decode().map_err(|_| "Word 字符引用无效")?;
                    output.push_str(quick_xml::escape::resolve_predefined_entity(&name).ok_or("不支持 Word 自定义实体")?);
                }
            }
            Event::DocType(_) => return Err("不支持带 DTD 的 Word XML".into()),
            Event::Eof => break,
            _ => (),
        }
        if output.len() > MAX_TEXT { return Err("提取文字超过 2 MiB".into()); }
    }
    Ok(output)
}

pub fn docx(text: &str) -> Result<Vec<u8>, String> {
    if text.len() > MAX_TEXT || text.chars().any(|c| !(c == '\t' || c == '\n' || c == '\r' || c >= ' ' && c != '\u{fffe}' && c != '\u{ffff}')) {
        return Err("文本过大或含 Word 不支持的控制字符，请清理后重试".into());
    }
    let mut document = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>");
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    for line in normalized.split('\n') {
        document.push_str("<w:p><w:r>");
        for (index, part) in line.split('\t').enumerate() {
            if index > 0 { document.push_str("<w:tab/>"); }
            document.push_str("<w:t xml:space=\"preserve\">");
            document.push_str(&quick_xml::escape::escape(part)); document.push_str("</w:t>");
        }
        document.push_str("</w:r></w:p>");
    }
    document.push_str("<w:sectPr/></w:body></w:document>");
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, body) in [
        ("[Content_Types].xml", "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>"),
        ("_rels/.rels", "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>"),
        ("word/document.xml", document.as_str()),
    ] {
        zip.start_file(name, zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)).map_err(|_| "Word 打包失败")?;
        zip.write_all(body.as_bytes()).map_err(|_| "Word 写入失败")?;
    }
    Ok(zip.finish().map_err(|_| "Word 打包失败")?.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn split_runs_entities_and_deleted_text() {
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>示例</w:t></w:r><w:r><w:t>公司 &amp; &#x4e2d;</w:t></w:r><w:del><w:r><w:delText>删除的秘密</w:delText></w:r></w:del></w:p></w:body></w:document>"#;
        let text = extract_xml(xml).unwrap();
        assert_eq!(text, "示例公司 & 中\n");
        let masked = crate::masking::replace_keywords(&text, &[crate::masking::Keyword { find: "示例公司".into(), replace: "公司 A".into() }]).unwrap();
        let bytes = docx(&masked.text).unwrap();
        let restored = read(&bytes, "docx").unwrap();
        assert!(restored.contains("公司 A & 中"));
        assert!(!restored.contains("示例") && !restored.contains("秘密"));
        assert_eq!(zip::ZipArchive::new(Cursor::new(bytes)).unwrap().len(), 3);
    }
    #[test]
    fn txt_encodings_and_output_names() {
        assert_eq!(read(b"\xef\xbb\xbfhello", "txt").unwrap(), "hello");
        assert_eq!(read(&[0xff, 0xfe, 0x2d, 0x4e], "txt").unwrap(), "中");
        assert_eq!(read(&[0xfe, 0xff, 0x4e, 0x2d], "txt").unwrap(), "中");
        assert!(read(&[0xff, 0xfe, 0x00], "txt").is_err());
        assert!(read(&[0xc4, 0xe3], "txt").is_err());
        assert!(output_name("客户名单.xlsx", "客户/名单", "xlsx").starts_with("客户名单_客户_名单_脱敏_"));
        assert!(docx("\u{0}").is_err());
    }
}
