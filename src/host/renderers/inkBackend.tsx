import React from "react";
import { render, type Instance } from "ink";
import type { RendererBackend } from "../rendererBackend.js";
import type { RenderFrame } from "../renderModel.js";
import type { HostStore } from "../store/index.js";
import { App } from "./ink/App.js";

export class InkBackend implements RendererBackend {
  #instance: Instance | undefined;
  #store: HostStore;
  #repoLabel: string | undefined;

  constructor(store: HostStore, repoLabel?: string) {
    this.#store = store;
    this.#repoLabel = repoLabel;
  }

  mount(): void {
    if (this.#instance) return;
    this.#instance =
      this.#repoLabel !== undefined
        ? render(<App store={this.#store} repoLabel={this.#repoLabel} />)
        : render(<App store={this.#store} />);
  }

  render(_frame?: RenderFrame): void {
    // State-driven — nothing to do. Store subscribers handle redraw.
  }

  dispose(): void {
    this.#instance?.unmount();
    this.#instance = undefined;
  }

  async waitUntilExit(): Promise<void> {
    await this.#instance?.waitUntilExit();
  }
}
