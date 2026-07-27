const ADSENSE_CLIENT = String(import.meta.env.VITE_ADSENSE_CLIENT || "").trim();

class ItsAdSlot extends HTMLElement {
  private observer: IntersectionObserver | null = null;
  private consent = false;

  connectedCallback(): void {
    this.hidden = true;
    if (!/^ca-pub-\d+$/.test(ADSENSE_CLIENT)) return;
    try {
      this.consent = JSON.parse(localStorage.getItem("its:consent:v1") || "null")?.advertising === true;
    } catch {
      this.consent = false;
    }
    window.addEventListener("its:consent-change", this.onConsent as EventListener);
    this.observer = new IntersectionObserver((entries) => {
      if (this.consent && entries.some((entry) => entry.isIntersecting)) this.load();
    }, { rootMargin: "300px" });
    this.observer.observe(this);
  }

  disconnectedCallback(): void {
    window.removeEventListener("its:consent-change", this.onConsent as EventListener);
    this.observer?.disconnect();
  }

  private onConsent = (event: CustomEvent<{ advertising?: boolean }>) => {
    this.consent = event.detail?.advertising === true;
    if (this.consent) this.load();
    else this.hidden = true;
  };

  private load(): void {
    const slot = String(this.dataset.slot || "").trim();
    if (!this.consent || !/^\d+$/.test(slot) || this.dataset.loaded === "true") return;
    if (!document.querySelector("script[data-its-adsense]")) {
      const script = document.createElement("script");
      script.async = true;
      script.crossOrigin = "anonymous";
      script.dataset.itsAdsense = "true";
      script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(ADSENSE_CLIENT)}`;
      document.head.appendChild(script);
    }
    this.style.display = "block";
    this.style.minHeight = this.dataset.height || "100px";
    this.innerHTML = `<ins class="adsbygoogle" style="display:block" data-ad-client="${ADSENSE_CLIENT}" data-ad-slot="${slot}" data-ad-format="auto" data-full-width-responsive="true"></ins>`;
    this.hidden = false;
    this.dataset.loaded = "true";
    (window as Window & { adsbygoogle?: unknown[] }).adsbygoogle = (window as Window & { adsbygoogle?: unknown[] }).adsbygoogle || [];
    (window as Window & { adsbygoogle?: unknown[] }).adsbygoogle?.push({});
  }
}

if (!customElements.get("its-ad-slot")) customElements.define("its-ad-slot", ItsAdSlot);
