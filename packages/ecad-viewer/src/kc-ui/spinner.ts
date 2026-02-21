/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { css, html } from "../base/web-components";
import { KCUIElement } from "./element";

/**
 * kc-ui-floating-toolbar is a toolbar that presents its elements on top of
 * another, such as a document viewer. It allows tools to take up minimal room
 * in the UI since unused areas of the toolbar are transparent and open to the
 * element belong.
 */
export class Spinner extends KCUIElement {
    static override get observedAttributes() {
        return ["text"];
    }

    get text(): string | null {
        return this.getAttribute("text");
    }

    set text(v: string | null) {
        const next = (v ?? "").toString();
        if (!next) this.removeAttribute("text");
        else this.setAttribute("text", next);
        this.#applyText();
    }

    #applyText() {
        try {
            const el = this.renderRoot?.querySelector(
                ".loading-text",
            ) as HTMLElement | null;
            if (!el) return;
            const t = (this.getAttribute("text") ?? "").trim();
            el.textContent = t;
            el.toggleAttribute("hidden", !t);
        } catch (_) {}
    }

    override attributeChangedCallback(
        name: string,
        _oldValue: string | null,
        _newValue: string | null,
    ) {
        if (name === "text") this.#applyText();
    }

    static override styles = [
        ...KCUIElement.styles,
        css`
            :host {
                height: 100%;
                width: 100%;
            }
            .loading-container {
                margin: 0;
                padding: 0;
                height: 100%; /* Make sure the body takes up the full height of the viewport */
                width: 100%;
                display: flex;
                flex-direction: column;
                justify-content: center; /* Center horizontally */
                align-items: center; /* Center vertically */
                gap: 10px;
            }

            .loading-spinner {
                border: 8px solid rgba(0, 0, 0, 0.1);
                border-left-color: #333;
                border-radius: 50%;
                width: 50px;
                height: 50px;
                animation: spin 1s linear infinite;
            }

            .loading-text {
                max-width: min(520px, 92%);
                padding: 0 12px;
                color: rgba(15, 23, 42, 0.75);
                font-size: 12px;
                line-height: 1.4;
                text-align: center;
                word-break: break-word;
            }

            @keyframes spin {
                to {
                    transform: rotate(360deg);
                }
            }
        `,
    ];

    override render() {
        return html`
            <div class="loading-container">
                <div class="loading-spinner"></div>
                <div class="loading-text" hidden></div>
            </div>
        `;
    }

    override renderedCallback(): void | undefined {
        this.#applyText();
    }
}

window.customElements.define("ecad-spinner", Spinner);
