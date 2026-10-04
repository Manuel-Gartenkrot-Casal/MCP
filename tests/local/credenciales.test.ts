import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CSV_CABECERA, generarPassword, filaCsv, anadirCredencial } from "../../local/credenciales";

describe("generarPassword", () => {
  it("20 caracteres de un alfabeto seguro con las cuatro clases", () => {
    for (let i = 0; i < 200; i++) {
      const p = generarPassword();
      expect(p).toHaveLength(20);
      expect(p).toMatch(/^[A-Za-z0-9!@#$%^&*\-_]+$/);
      expect(p).toMatch(/[a-z]/); expect(p).toMatch(/[A-Z]/); expect(p).toMatch(/[0-9]/); expect(p).toMatch(/[!@#$%^&*\-_]/);
    }
  });
  it("nunca empieza por símbolo: la neutralización del CSV alteraría la contraseña real", () => {
    for (let i = 0; i < 2000; i++) expect(generarPassword()).toMatch(/^[A-Za-z0-9]/);
  });
  it("1000 contraseñas distintas", () => {
    expect(new Set(Array.from({ length: 1000 }, generarPassword)).size).toBe(1000);
  });
});

describe("filaCsv", () => {
  const f = { nombre: "Vercel", url: "https://vercel.com/signup", usuario: "a@b.c", password: "pw" };
  it("orden name,url,username,password", () => {
    expect(CSV_CABECERA).toBe("name,url,username,password");
    expect(filaCsv(f)).toBe("Vercel,https://vercel.com/signup,a@b.c,pw");
  });
  it("escapa comas, comillas y saltos de línea", () => {
    expect(filaCsv({ ...f, nombre: 'a,b', password: 'x"y', url: "l1\nl2" })).toBe('"a,b","l1\nl2",a@b.c,"x""y"');
  });
  it.each(["=1+1", "+1", "-1", "@x"])("neutraliza %s al inicio (inyección de fórmulas)", (v) => {
    expect(filaCsv({ ...f, password: v })).toBe(`Vercel,https://vercel.com/signup,a@b.c,'${v}`);
  });
  it("el email que empieza por @ o = también se neutraliza", () => {
    expect(filaCsv({ ...f, usuario: "=cmd" })).toContain(",'=cmd,");
  });
});

describe("anadirCredencial", () => {
  it("cabecera una sola vez, filas añadidas y 0600 fuera de win32", async () => {
    const ruta = join(await mkdtemp(join(tmpdir(), "cred-")), "sub", "c.csv");
    const f = { nombre: "A", url: "https://a.example", usuario: "u@x.y", password: "p1" };
    await anadirCredencial(ruta, f);
    await anadirCredencial(ruta, { ...f, nombre: "B", password: "p2" });
    expect((await readFile(ruta, "utf8")).trim().split("\n")).toEqual([CSV_CABECERA, "A,https://a.example,u@x.y,p1", "B,https://a.example,u@x.y,p2"]);
    if (process.platform !== "win32") expect((await stat(ruta)).mode & 0o777).toBe(0o600);
  });
});
