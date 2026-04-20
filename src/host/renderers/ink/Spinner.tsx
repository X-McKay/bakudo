import React, { useEffect, useState } from "react";
import { Text } from "ink";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const Spinner = ({ color }: { color?: string }) => {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((x) => (x + 1) % FRAMES.length), 80);
    // Don't keep the event loop alive just for spinner animation — Ink's own
    // stdin hook keeps the process running during interactive use, and tests
    // can exit cleanly without explicitly unmounting.
    id.unref?.();
    return () => clearInterval(id);
  }, []);
  return <Text {...(color !== undefined ? { color } : {})}>{FRAMES[i]}</Text>;
};
