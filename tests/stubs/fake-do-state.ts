// Estado falso de Durable Object para tests.
// const st = fakeDOState(); new SesionDO(st, env);
// st.data: Map crudo del almacenamiento; st.alarm(): último setAlarm (ms) o null.
// put(k, v) y put({k: v, ...}) (atómico). deleteAll NO borra la alarma (como el real).
export function fakeDOState() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    data,
    alarm: () => alarm,
    storage: {
      get: async (k: string) => data.get(k),
      put: async (k: string | Record<string, unknown>, v?: unknown) => {
        if (typeof k === "string") data.set(k, v);
        else for (const [kk, vv] of Object.entries(k)) data.set(kk, vv);
      },
      delete: async (k: string) => data.delete(k),
      deleteAll: async () => { data.clear(); },
      setAlarm: async (ms: number) => { alarm = ms; },
      getAlarm: async () => alarm,
    },
  } as any;
}
