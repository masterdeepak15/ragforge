import { createContext, useContext } from 'react';
import type { SetupStatus } from '../types/api';

interface SetupStatusValue {
  status: SetupStatus | null;
  /** Re-reads the status from the server so routing reflects what the wizard just did. */
  refresh: () => Promise<void>;
}

const SetupStatusContext = createContext<SetupStatusValue>({ status: null, refresh: async () => {} });

export const SetupStatusProvider = SetupStatusContext.Provider;

export function useSetupStatus(): SetupStatusValue {
  return useContext(SetupStatusContext);
}
