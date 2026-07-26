import "./navigation3d.css";
import { Navigation3D } from "./Navigation3D";
import { MODE_PROFILES } from "./services";
import type { NavigationMode } from "./types";

declare global {
  interface Window {
    itsNavigation3D?: Navigation3D;
  }
}

let webMcpRegistered = false;

function isNavigationMode(value: unknown): value is NavigationMode {
  return typeof value === "string" && Object.hasOwn(MODE_PROFILES, value);
}

function registerNavigationTool(navigation: Navigation3D): void {
  if (webMcpRegistered) return;
  const modelContext = document.modelContext || navigator.modelContext;
  if (!modelContext?.registerTool) return;
  webMcpRegistered = true;
  try {
    const pending = modelContext.registerTool({
      name: "open_its_maps_3d_navigation",
      description:
        "Open the accessible ITS Maps destination search and 3D route preview for a place and travel mode.",
      inputSchema: {
        type: "object",
        properties: {
          destination: {
            type: "string",
            description: "Destination, road, building, city, station, or public place to search.",
          },
          mode: {
            type: "string",
            enum: Object.keys(MODE_PROFILES),
            description: "Travel mode: car, motorcycle, truck, bicycle, walk, or transit.",
          },
        },
      },
      annotations: { readOnlyHint: true },
      execute: (input) => {
        const query = typeof input.destination === "string" ? input.destination.slice(0, 180) : "";
        const mode = isNavigationMode(input.mode) ? input.mode : undefined;
        navigation.openSearch(query, mode);
        const result = {
          opened: true,
          destination: query || null,
          mode: mode || "car",
          note: "The user must select a geocoder result and explicitly start navigation or simulation.",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      },
    });
    if (pending && typeof (pending as Promise<void>).catch === "function") {
      void (pending as Promise<void>).catch(() => {
        webMcpRegistered = false;
      });
    }
  } catch {
    webMcpRegistered = false;
  }
}

function startNavigationModule(): void {
  if (window.itsNavigation3D) return;
  const navigation = new Navigation3D();
  window.itsNavigation3D = navigation;
  navigation.mount();
  registerNavigationTool(navigation);
  window.setTimeout(() => registerNavigationTool(navigation), 1_500);
  window.setTimeout(() => registerNavigationTool(navigation), 6_000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startNavigationModule, { once: true });
} else {
  startNavigationModule();
}
