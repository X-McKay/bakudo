import React from "react";
import { render, type Instance } from "ink";
import type { RendererBackend } from "../rendererBackend.js";
import type { RenderFrame } from "../renderModel.js";
import type { HostStore } from "../store/index.js";
import { App } from "./ink/App.js";
import type { RunTurn } from "./ink/TurnDriver.js";

export class InkBackend implements RendererBackend {
  #instance: Instance | undefined;
  #store: HostStore;
  #repoLabel: string | undefined;
  #runTurn: RunTurn | undefined;

  constructor(store: HostStore, repoLabel?: string, runTurn?: RunTurn) {
    this.#store = store;
    this.#repoLabel = repoLabel;
    this.#runTurn = runTurn;
  }

  mount(): void {
    if (this.#instance) return;
    // exactOptionalPropertyTypes: only include the optional props when defined.
    const repoLabel = this.#repoLabel;
    const runTurn = this.#runTurn;
    if (repoLabel !== undefined && runTurn !== undefined) {
      this.#instance = render(
        <App store={this.#store} repoLabel={repoLabel} runTurn={runTurn} />,
      );
    } else if (repoLabel !== undefined) {
      this.#instance = render(<App store={this.#store} repoLabel={repoLabel} />);
    } else if (runTurn !== undefined) {
      this.#instance = render(<App store={this.#store} runTurn={runTurn} />);
    } else {
      this.#instance = render(<App store={this.#store} />);
    }
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
