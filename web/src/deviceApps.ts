export const ITS_WINDOWS_PACKAGE_FAMILY_NAME = "HanifaTeams.ITSMaps_mqhjscd51gq8g";
export const ITS_WINDOWS_APPLICATION_ID = "ITSMaps";
export const ITS_WINDOWS_RELATED_APP_ID = `${ITS_WINDOWS_PACKAGE_FAMILY_NAME}!${ITS_WINDOWS_APPLICATION_ID}`;
export const ITS_MICROSOFT_STORE_PRODUCT_ID = "9MWFGGW3FD2C";

type InstalledRelatedApp = {
  id?: string;
  platform?: string;
  url?: string;
  version?: string;
};

type RelatedAppsNavigator = Navigator & {
  getInstalledRelatedApps?: () => Promise<InstalledRelatedApp[]>;
};

export type ItsDeviceAppStatus = {
  supported: boolean;
  installed: boolean;
  app: InstalledRelatedApp | null;
  checkedAt: number;
  error: string | null;
};

export type MicrosoftStoreReview = {
  author: string;
  title: string;
  body: string;
  rating: number;
  updatedAt: string;
};

export type MicrosoftStorePublicSnapshot = {
  available: boolean;
  averageRating: number | null;
  ratingCount: number | null;
  acquisitionCount: number | null;
  reviews: MicrosoftStoreReview[];
  updatedAt: string | null;
  sourceUrl: string | null;
};

const EMPTY_STORE_SNAPSHOT: MicrosoftStorePublicSnapshot = {
  available: false,
  averageRating: null,
  ratingCount: null,
  acquisitionCount: null,
  reviews: [],
  updatedAt: null,
  sourceUrl: null,
};

let relatedAppStatusPromise: Promise<ItsDeviceAppStatus> | null = null;
let storeSnapshotPromise: Promise<MicrosoftStorePublicSnapshot> | null = null;

function finiteNumber(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function safeText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeStoreReview(value: unknown): MicrosoftStoreReview | null {
  if (!value || typeof value !== "object") return null;
  const review = value as Record<string, unknown>;
  const rating = finiteNumber(review.rating, 1, 5);
  const body = safeText(review.body ?? review.text, 1200);
  if (rating === null || !body) return null;
  return {
    author: safeText(review.author ?? review.reviewerName, 80) || "Pengguna Microsoft Store",
    title: safeText(review.title, 140),
    body,
    rating,
    updatedAt: safeText(review.updatedAt ?? review.date, 64),
  };
}

function normalizeStoreSnapshot(value: unknown): MicrosoftStorePublicSnapshot {
  if (!value || typeof value !== "object") return EMPTY_STORE_SNAPSHOT;
  const source = value as Record<string, unknown>;
  const averageRating = finiteNumber(source.averageRating, 0, 5);
  const ratingCount = finiteNumber(source.ratingCount, 0);
  const acquisitionCount = finiteNumber(source.acquisitionCount ?? source.downloadCount, 0);
  const reviews = Array.isArray(source.reviews)
    ? source.reviews.map(normalizeStoreReview).filter((review): review is MicrosoftStoreReview => Boolean(review)).slice(0, 3)
    : [];
  const available = Boolean(
    source.verified === true
      && (averageRating !== null || ratingCount !== null || acquisitionCount !== null || reviews.length),
  );
  return {
    available,
    averageRating: available ? averageRating : null,
    ratingCount: available ? ratingCount : null,
    acquisitionCount: available ? acquisitionCount : null,
    reviews: available ? reviews : [],
    updatedAt: available ? safeText(source.updatedAt, 64) || null : null,
    sourceUrl: available ? safeText(source.sourceUrl, 500) || null : null,
  };
}

export function queryItsWindowsAppInstallation(force = false): Promise<ItsDeviceAppStatus> {
  if (!force && relatedAppStatusPromise) return relatedAppStatusPromise;
  relatedAppStatusPromise = (async () => {
    const relatedAppsNavigator = navigator as RelatedAppsNavigator;
    if (typeof relatedAppsNavigator.getInstalledRelatedApps !== "function") {
      return { supported: false, installed: false, app: null, checkedAt: Date.now(), error: null };
    }
    try {
      const apps = await relatedAppsNavigator.getInstalledRelatedApps();
      const app = apps.find((candidate) => candidate.id === ITS_WINDOWS_RELATED_APP_ID)
        ?? apps.find((candidate) => candidate.platform?.toLowerCase() === "windows")
        ?? null;
      return { supported: true, installed: Boolean(app), app, checkedAt: Date.now(), error: null };
    } catch (error) {
      return {
        supported: true,
        installed: false,
        app: null,
        checkedAt: Date.now(),
        error: error instanceof Error ? error.message : "Pemeriksaan aplikasi ditolak browser.",
      };
    }
  })();
  return relatedAppStatusPromise;
}

export function fetchMicrosoftStorePublicSnapshot(_firebaseRootUrl: string, force = false): Promise<MicrosoftStorePublicSnapshot> {
  if (!force && storeSnapshotPromise) return storeSnapshotPromise;
  storeSnapshotPromise = (async () => {
    // Anonymous RTDB reads are intentionally denied by the production rules.
    // The publisher-generated Hosting snapshot is the public data contract.
    const endpoints = ["/data/microsoft-store.json"];
    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint, { cache: "no-store" });
        if (!response.ok) continue;
        const snapshot = normalizeStoreSnapshot(await response.json());
        if (snapshot.available) return snapshot;
      } catch {
        // The publisher snapshot is optional; the Store link remains available.
      }
    }
    return EMPTY_STORE_SNAPSHOT;
  })();
  return storeSnapshotPromise;
}
