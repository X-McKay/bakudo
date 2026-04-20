import React from "react";
import { Box } from "ink";
import type { HostStore } from "../../store/index.js";
import { StoreProvider } from "./StoreProvider.js";
import { Header } from "./Header.js";
import { Transcript } from "./Transcript.js";
import { Composer } from "./Composer.js";
import { Footer } from "./Footer.js";
import { OverlayStack } from "./OverlayStack.js";

export const App = ({ store, repoLabel }: { store: HostStore; repoLabel?: string }) => (
  <StoreProvider store={store}>
    <Box flexDirection="column">
      {repoLabel !== undefined ? <Header repoLabel={repoLabel} /> : <Header />}
      <Box height={1} />
      <Transcript />
      <Box height={1} />
      <OverlayStack />
      <Footer />
      <Composer />
    </Box>
  </StoreProvider>
);
