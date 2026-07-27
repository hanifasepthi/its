import styles from "./ItsMapsApp.module.css";

const ELEMENT_NAME = "its-maps-app";

class ItsMapsApp extends HTMLElement {
  connectedCallback(): void {
    this.classList.add(styles.shell);
    this.dataset.brand = "ITS Maps";
    this.setAttribute("role", "application");
    this.setAttribute("aria-label", "ITS Maps");
  }
}

export function registerItsMapsApp(): void {
  if (!window.customElements.get(ELEMENT_NAME)) {
    window.customElements.define(ELEMENT_NAME, ItsMapsApp);
  }
}

registerItsMapsApp();
