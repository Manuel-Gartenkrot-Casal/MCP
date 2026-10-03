import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leer, marcar } from "../../local/memoria";

let dir: string;
beforeEach(async () => { dir = join(await mkdtemp(join(tmpdir(), "mem-")), "sub"); });
const archivo = () => join(dir, "servicios.json");

describe("memoria local", () => {
  it("leer sin archivo → []", async () => expect(await leer(dir)).toEqual([]));

  it("marcar crea directorio y archivo; leer lo devuelve con fecha ISO", async () => {
    const r = await marcar(dir, { servicio: "vercel", estado: "registrado" });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ servicio: "vercel", estado: "registrado" });
    expect(new Date(r[0].fecha).toISOString()).toBe(r[0].fecha);
    expect(await leer(dir)).toEqual(r);
  });

  it("marcar dos veces no duplica y actualiza estado", async () => {
    await marcar(dir, { servicio: "vercel", estado: "registrado" });
    const r = await marcar(dir, { servicio: "vercel", estado: "conectado" });
    expect(r).toHaveLength(1);
    expect(r[0].estado).toBe("conectado");
  });

  it("quitado elimina la entrada", async () => {
    await marcar(dir, { servicio: "vercel", estado: "registrado" });
    await marcar(dir, { servicio: "github", estado: "registrado" });
    const r = await marcar(dir, { servicio: "vercel", estado: "quitado" });
    expect(r.map((x) => x.servicio)).toEqual(["github"]);
  });

  it.each([
    [{ servicio: "../x", estado: "registrado" }],
    [{ servicio: "A", estado: "registrado" }],
    [{ servicio: "a".repeat(33), estado: "registrado" }],
    [{ servicio: "", estado: "registrado" }],
    [{ servicio: "ok", estado: "otro" }],
    [{ servicio: "ok", estado: "registrado", clave: "hunter2" }],
    [null],
    ["texto"],
  ])("entrada inválida %j → rechazada sin tocar el disco", async (entrada) => {
    await expect(marcar(dir, entrada)).rejects.toThrow();
    await expect(stat(dir)).rejects.toThrow(); // ni siquiera se crea el directorio
  });

  it("archivo corrupto → leer y marcar fallan y el contenido queda intacto", async () => {
    await marcar(dir, { servicio: "ok", estado: "registrado" });
    await writeFile(archivo(), "{no json");
    await expect(leer(dir)).rejects.toThrow(/corrupto/);
    await expect(marcar(dir, { servicio: "otro", estado: "registrado" })).rejects.toThrow(/corrupto/);
    expect(await readFile(archivo(), "utf8")).toBe("{no json");
  });

  it("JSON válido con forma inesperada también cuenta como corrupto", async () => {
    await marcar(dir, { servicio: "ok", estado: "registrado" });
    await writeFile(archivo(), JSON.stringify([{ servicio: "ok", estado: "registrado", fecha: "x", clave: "s" }]));
    await expect(leer(dir)).rejects.toThrow(/corrupto/);
  });

  it.skipIf(process.platform === "win32")("permisos 0600 en archivo y 0700 en directorio", async () => {
    await marcar(dir, { servicio: "ok", estado: "registrado" });
    expect((await stat(archivo())).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("llamadas paralelas a marcar no pierden entradas ni corrompen el archivo", async () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    for (let ronda = 0; ronda < 5; ronda++) {
      await Promise.all(ids.map((servicio) => marcar(dir, { servicio: `${servicio}${ronda}`, estado: "registrado" })));
    }
    const r = await leer(dir);
    expect(r).toHaveLength(ids.length * 5);
  });
});
