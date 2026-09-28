// All coordinates are Electron DIPs. Anchor the visible canvas, not its bubble margin.
function petLayout(anchor, scale, area) {
  const width = 144 * scale, height = 156 * scale;
  const petX = Math.max(area.x, Math.min(anchor.x, area.x + area.width - width));
  const petY = Math.max(area.y, Math.min(anchor.y, area.y + area.height - height));
  const windowWidth = 320, windowHeight = Math.ceil(198 + height);
  const below = petY - area.y < 180;
  const x = Math.round(Math.max(area.x, Math.min(petX + width / 2 - 160, area.x + area.width - windowWidth)));
  const y = Math.round(Math.max(area.y, Math.min(below ? petY : petY - 190, area.y + area.height - windowHeight)));
  return { bounds: { x, y, width: windowWidth, height: windowHeight }, anchor: { x: petX, y: petY }, offset: { x: petX - x, y: petY - y }, below };
}
module.exports = { petLayout };
