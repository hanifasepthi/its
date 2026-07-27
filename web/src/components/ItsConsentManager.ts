import styles from "./ItsConsentManager.module.css?inline";

type ConsentChoice = { analytics: boolean; advertising: boolean };
const STORAGE_KEY = "its:consent:v1";

function storedChoice(): ConsentChoice | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as Partial<ConsentChoice> | null;
    return parsed && typeof parsed.analytics === "boolean" && typeof parsed.advertising === "boolean"
      ? { analytics: parsed.analytics, advertising: parsed.advertising }
      : null;
  } catch {
    return null;
  }
}

class ItsConsentManager extends HTMLElement {
  connectedCallback(): void {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>${styles}</style>
      <button class="preferences" type="button" aria-haspopup="dialog">Pengaturan Privasi</button>
      <dialog aria-labelledby="consent-title">
        <form method="dialog">
          <h2 id="consent-title">Privasi ITS Maps</h2>
          <p>Analitik membantu memperbaiki aplikasi. Koordinat, isi chat, video, dan data perangkat tidak dikirim.</p>
          <label><input name="analytics" type="checkbox"> Izinkan analitik</label>
          <label><input name="advertising" type="checkbox"> Izinkan iklan</label>
          <div class="actions">
            <button value="cancel" type="submit">Batal</button>
            <button class="save" value="save" type="submit">Simpan</button>
          </div>
        </form>
      </dialog>`;
    const dialog = root.querySelector("dialog") as HTMLDialogElement;
    const analytics = root.querySelector<HTMLInputElement>('input[name="analytics"]')!;
    const advertising = root.querySelector<HTMLInputElement>('input[name="advertising"]')!;
    const apply = (choice: ConsentChoice) => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
      window.dispatchEvent(new CustomEvent("its:consent-change", { detail: choice }));
    };
    root.querySelector(".preferences")?.addEventListener("click", () => {
      const choice = storedChoice() || { analytics: false, advertising: false };
      analytics.checked = choice.analytics;
      advertising.checked = choice.advertising;
      dialog.showModal();
    });
    dialog.addEventListener("close", () => {
      if (dialog.returnValue === "save") apply({ analytics: analytics.checked, advertising: advertising.checked });
    });
    const initial = storedChoice();
    if (initial) queueMicrotask(() => apply(initial));
    else queueMicrotask(() => dialog.showModal());
  }
}

if (!customElements.get("its-consent-manager")) customElements.define("its-consent-manager", ItsConsentManager);
if (!document.querySelector("its-consent-manager")) document.body.appendChild(document.createElement("its-consent-manager"));
