import { useCallback, useEffect, useState } from "react";
import {
  deleteClient,
  inTauri,
  listClients,
  saveClient,
  type SaveClientInput,
} from "./ipc";
import type { Client } from "./types";
import { CLIENTS as FIXTURE_CLIENTS } from "../test-fixtures/data";

export interface UseClients {
  clients: Client[];
  refresh: () => Promise<void>;
  create: (input: SaveClientInput) => Promise<Client>;
  update: (input: SaveClientInput & { id: string }) => Promise<Client>;
  remove: (id: string) => Promise<void>;
}

function localClient(input: SaveClientInput, id?: string): Client {
  return {
    id: id ?? `local-${input.name.trim().toLowerCase().replace(/\s+/g, "-")}`,
    name: input.name.trim(),
    color: input.color ?? null,
    archived: input.archived ?? false,
  };
}

export function useClients(): UseClients {
  const [clients, setClients] = useState<Client[]>(
    inTauri ? [] : FIXTURE_CLIENTS,
  );

  const refresh = useCallback(async () => {
    if (!inTauri) return;
    try {
      setClients(await listClients());
    } catch (e) {
      console.error("list_clients failed", e);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(
    async (input: SaveClientInput): Promise<Client> => {
      if (!inTauri) {
        const local = localClient(input);
        setClients((prev) =>
          prev.some((c) => c.id === local.id) ? prev : [...prev, local],
        );
        return local;
      }
      const saved = await saveClient(input);
      setClients((prev) => [...prev.filter((c) => c.id !== saved.id), saved]);
      return saved;
    },
    [],
  );

  const update = useCallback(
    async (input: SaveClientInput & { id: string }): Promise<Client> => {
      if (!inTauri) {
        const next = localClient(input, input.id);
        setClients((prev) => prev.map((c) => (c.id === next.id ? next : c)));
        return next;
      }
      const saved = await saveClient(input);
      setClients((prev) => prev.map((c) => (c.id === saved.id ? saved : c)));
      return saved;
    },
    [],
  );

  const remove = useCallback(async (id: string): Promise<void> => {
    if (inTauri) await deleteClient(id);
    setClients((prev) => prev.filter((c) => c.id !== id));
  }, []);

  return { clients, refresh, create, update, remove };
}
