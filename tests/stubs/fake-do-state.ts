// Estado falso de Durable Object para tests.
// const st = fakeDOState(); new SesionDO(st, env);
// st.data: Map crudo del almacenamiento; st.alarm(): último setAlarm (ms) o null.
export function fakeDOState() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    data,
    alarm: () => alarm,
    storage: {
      get: async (k: string) => data.get(k),
      put: async (k: string, v: unknown) => { data.set(k, v); },
      delete: async (k: string) => data.delete(k),
      deleteAll: async () => { data.clear(); alarm = null; },
      setAlarm: async (ms: number) => { alarm = ms; },
      getAlarm: async () => alarm,
    },
  } as any;
}
