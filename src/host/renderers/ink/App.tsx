import React, { useEffect } from "react";
import { Box, useApp } from "ink";
import type { HostStore } from "../../store/index.js";
import { StoreProvider } from "./StoreProvider.js";
import { Header } from "./Header.js";
import { Transcript } from "./Transcript.js";
import { Composer } from "./Composer.js";
import { Footer } from "./Footer.js";
import { OverlayStack } from "./OverlayStack.js";
import { Sidebar } from "./Sidebar.js";
import { TurnDriver, type RunTurn } from "./TurnDriver.js";
import { useAppState } from "./hooks/useAppState.js";

/**
 * Renderless child: when the reducer sets `shouldExit`, call `ink.exit()`
 * so `render(...).waitUntilExit()` resolves and the bootstrap returns.
 * Must live inside `<StoreProvider>` because it reads `useAppState`.
 */
const ExitWatcher = () => {
  const { exit } = useApp();
  const shouldExit = useAppState((s) => s.shouldExit);
  useEffect(() => {
    if (shouldExit) exit();
  }, [shouldExit, exit]);
  return null;
};

/**
 * Left panel: the main transcript + composer area.
 * Takes all remaining horizontal space when the sidebar is visible.
 */
const MainPanel = ({ repoLabel }: { repoLabel?: string | undefined }) => (
  <Box flexDirection="column" flexGrow={1}>
    {repoLabel !== undefined ? <Header repoLabel={repoLabel} /> : <Header />}
    <Box height={1} />
    <Transcript />
    <Box height={1} />
    <OverlayStack />
    <Footer />
    <Composer />
  </Box>
);

export const App = ({
  store,
  repoLabel,
  runTurn,
}: {
  store: HostStore;
  repoLabel?: string;
  runTurn?: RunTurn;
}) => (
  <StoreProvider store={store}>
    {/* Horizontal split: left panel (transcript + composer) + right sidebar */}
    <Box flexDirection="row">
      <MainPanel repoLabel={repoLabel} />
      <Sidebar />
    </Box>
    {runTurn !== undefined ? <TurnDriver runTurn={runTurn} /> : null}
    <ExitWatcher />
  </StoreProvider>
);
