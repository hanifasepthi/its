import { Protocol } from "pmtiles";

const DEFAULT_ARCHIVE_URL = "https://its.hanifahseptiani45.workers.dev/v1/map/archive/indonesia.pmtiles";

let protocolInstalled = false;

export async function nationalVectorStyle(maplibregl: any): Promise<string | Record<string, unknown>> {
  const archiveUrl = String(import.meta.env.VITE_INDONESIA_PMTILES_URL || DEFAULT_ARCHIVE_URL).trim();
  if (!archiveUrl) throw new Error("Arsip vektor nasional belum dikonfigurasi.");
  if (!protocolInstalled) {
    const protocol = new Protocol();
    maplibregl.addProtocol("pmtiles", protocol.tile);
    protocolInstalled = true;
  }
  // Use the ITS style written against this archive's exact OpenMapTiles
  // schema. A generic provider style produced numeric-null worker warnings and
  // made street mode visually dependent on a third party even though the
  // national archive was already available.
  const { navigationStyle } = await import("../navigation3d/NavigationLayers");
  const style = navigationStyle() as Record<string, any>;
  const nationalSource = style.sources?.["its-national"];
  if (nationalSource) nationalSource.url = `pmtiles://${archiveUrl}`;
  style.name = "ITS Maps Indonesia National Vector";
  style.metadata = {
    ...(style.metadata || {}),
    "its:archive": archiveUrl,
    "its:data": "OpenStreetMap Indonesia snapshot, tiled by ITS Maps",
  };
  return style;
}
