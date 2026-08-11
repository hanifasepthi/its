import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const poiRoot = path.join(root, "src", "poi");
const sourceManifestPath = path.join(poiRoot, "source-manifest.json");
const outputManifestPath = path.join(poiRoot, "manifest.json");

function slug(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function clampInteger(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function cellCrop(icon, sheet, metadata) {
  if (icon.crop) {
    const left = clampInteger(icon.crop.x, 0, metadata.width - 1);
    const top = clampInteger(icon.crop.y, 0, metadata.height - 1);
    const width = clampInteger(icon.crop.width, 1, metadata.width - left);
    const height = clampInteger(icon.crop.height, 1, metadata.height - top);
    return {
      region: { left, top, width, height },
      anchorX: clampInteger(icon.crop.anchorX ?? width / 2, 0, width - 1),
    };
  }
  const cellWidth = metadata.width / sheet.columns;
  const cellHeight = metadata.height / sheet.rows;
  // The source artwork deliberately crosses nominal grid boundaries. A generous
  // crop prevents flat edges; component isolation below removes neighbouring art.
  const bleed = cellWidth * (sheet.bleedX ?? 0.14);
  const cellLeft = icon.column * cellWidth;
  const cellRight = cellLeft + cellWidth;
  const left = Math.round(Math.max(0, cellLeft - bleed) + (sheet.insetX || 0));
  const top = Math.round(icon.row * cellHeight + (sheet.insetY || 0));
  const right = Math.round(Math.min(metadata.width, cellRight + bleed) - (sheet.insetX || 0));
  const width = right - left;
  const height = Math.round(cellHeight * (icon.contentRatio || sheet.contentRatio || 0.78));
  const region = {
    left: clampInteger(left, 0, metadata.width - 1),
    top: clampInteger(top, 0, metadata.height - 1),
    width: clampInteger(width, 1, metadata.width - left),
    height: clampInteger(height, 1, metadata.height - top),
  };
  return {
    region,
    anchorX: clampInteger(cellLeft + cellWidth / 2 - region.left, 0, region.width - 1),
  };
}

function isBackgroundCandidate(red, green, blue) {
  const minimum = Math.min(red, green, blue);
  const maximum = Math.max(red, green, blue);
  return minimum >= 208 && maximum - minimum <= 42;
}

function removeConnectedCheckerboard(data, width, height, channels) {
  const count = width * height;
  const visited = new Uint8Array(count);
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;

  const enqueue = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const pixel = y * width + x;
    if (visited[pixel]) return;
    const offset = pixel * channels;
    if (!isBackgroundCandidate(data[offset], data[offset + 1], data[offset + 2])) return;
    visited[pixel] = 1;
    queue[tail++] = pixel;
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }

  while (head < tail) {
    const pixel = queue[head++];
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    enqueue(x - 1, y);
    enqueue(x + 1, y);
    enqueue(x, y - 1);
    enqueue(x, y + 1);
  }

  const output = Buffer.alloc(count * 4);
  for (let pixel = 0; pixel < count; pixel += 1) {
    const sourceOffset = pixel * channels;
    const targetOffset = pixel * 4;
    output[targetOffset] = data[sourceOffset];
    output[targetOffset + 1] = data[sourceOffset + 1];
    output[targetOffset + 2] = data[sourceOffset + 2];
    output[targetOffset + 3] = visited[pixel] ? 0 : channels >= 4 ? data[sourceOffset + 3] : 255;
  }
  return output;
}

function isolateCenteredComponent(data, width, height, anchorX) {
  const count = width * height;
  const labels = new Int32Array(count);
  const queue = new Int32Array(count);
  const components = [];

  for (let start = 0; start < count; start += 1) {
    if (labels[start] || data[start * 4 + 3] < 16) continue;
    const label = components.length + 1;
    let head = 0;
    let tail = 0;
    let sumX = 0;
    queue[tail++] = start;
    labels[start] = label;

    while (head < tail) {
      const pixel = queue[head++];
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      sumX += x;
      const neighbours = [pixel - 1, pixel + 1, pixel - width, pixel + width];
      for (const neighbour of neighbours) {
        if (neighbour < 0 || neighbour >= count || labels[neighbour]) continue;
        const neighbourX = neighbour % width;
        if (Math.abs(neighbourX - x) > 1 || data[neighbour * 4 + 3] < 16) continue;
        labels[neighbour] = label;
        queue[tail++] = neighbour;
      }
    }

    const centerX = sumX / tail;
    const distancePenalty = Math.min(0.82, Math.abs(centerX - anchorX) / Math.max(1, width * 0.62));
    components.push({ label, area: tail, score: tail * (1 - distancePenalty) });
  }

  const selected = components.sort((a, b) => b.score - a.score)[0];
  if (!selected) return data;
  for (let pixel = 0; pixel < count; pixel += 1) {
    if (labels[pixel] !== selected.label) data[pixel * 4 + 3] = 0;
  }
  return data;
}

async function transparentCrop(sourcePath, crop) {
  const { data, info } = await sharp(sourcePath)
    .extract(crop.region)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgba = removeConnectedCheckerboard(data, info.width, info.height, info.channels);
  const isolated = isolateCenteredComponent(rgba, info.width, info.height, crop.anchorX);
  return sharp(isolated, {
    raw: { width: info.width, height: info.height, channels: 4 },
  }).trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 4 });
}

async function writeVariant(image, outputPath, size, padding) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await image
    .clone()
    .resize(size - padding * 2, size - padding * 2, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .extend({
      top: padding,
      right: padding,
      bottom: padding,
      left: padding,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .webp({ lossless: true, effort: 5 })
    .toFile(outputPath);
}

async function assertTransparentCorners(filePath) {
  const { data, info } = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alphaAt = (x, y) => data[(y * info.width + x) * info.channels + 3];
  const corners = [
    alphaAt(0, 0),
    alphaAt(info.width - 1, 0),
    alphaAt(0, info.height - 1),
    alphaAt(info.width - 1, info.height - 1),
  ];
  if (corners.some((alpha) => alpha !== 0)) {
    throw new Error(`Sudut aset belum transparan: ${path.relative(root, filePath)}`);
  }
}

async function main() {
  const sourceManifest = JSON.parse(await fs.readFile(sourceManifestPath, "utf8"));
  const ids = new Set();
  const generated = [];

  for (const icon of sourceManifest.icons) {
    if (!icon.id || ids.has(icon.id)) throw new Error(`Duplicate/invalid icon id: ${icon.id}`);
    ids.add(icon.id);
    const sheet = sourceManifest.sheets[icon.sheet];
    if (!sheet) throw new Error(`Sheet tidak ditemukan untuk ${icon.id}: ${icon.sheet}`);
    const sourcePath = path.join(poiRoot, sheet.src);
    await fs.access(sourcePath);
    const metadata = await sharp(sourcePath).metadata();
    if (!metadata.width || !metadata.height) throw new Error(`Dimensi sheet tidak valid: ${sheet.src}`);
    const crop = cellCrop(icon, sheet, metadata);
    const image = await transparentCrop(sourcePath, crop);
    const [domain, name = "place"] = icon.id.split(".", 2);
    const filename = `${slug(name)}.webp`;
    const microRelative = `micro/${slug(domain)}/${filename}`;
    const heroRelative = `hero/${slug(domain)}/${filename}`;
    const microPath = path.join(poiRoot, microRelative);
    const heroPath = path.join(poiRoot, heroRelative);
    await writeVariant(image, microPath, 96, 8);
    await writeVariant(image, heroPath, 256, 16);
    await assertTransparentCorners(microPath);
    await assertTransparentCorners(heroPath);
    generated.push({
      ...icon,
      micro: `./${microRelative.replaceAll("\\", "/")}`,
      hero: `./${heroRelative.replaceAll("\\", "/")}`,
    });
  }

  for (const required of sourceManifest.requiredFallbacks || []) {
    if (!ids.has(required)) throw new Error(`Fallback wajib belum ada: ${required}`);
  }

  const manifest = {
    version: sourceManifest.version,
    requiredFallbacks: sourceManifest.requiredFallbacks || [],
    icons: generated,
  };
  await fs.writeFile(outputManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`Generated ${generated.length} POI icon pairs.\n`);
}

await main();
