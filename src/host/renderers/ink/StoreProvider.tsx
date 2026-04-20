import React, { createContext, useContext, type ReactNode } from "react";
import type { HostStore } from "../../store/index.js";

const StoreContext = createContext<HostStore | null>(null);

export const StoreProvider = ({
  store,
  children,
}: {
  store: HostStore;
  children: ReactNode;
}) => <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;

export const useStore = (): HostStore => {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore must be used inside StoreProvider");
  return store;
};
