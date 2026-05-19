/**
 * QuickJS-in-WASM loader for Cloudflare Workers.
 *
 * Workers blocks `new Function()` / `eval()` at the V8 level, so we run
 * user code inside a WASM-compiled QuickJS interpreter instead. Code still
 * executes as real JavaScript — just inside a nested engine, not the host
 * isolate.
 */
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
} from "quickjs-emscripten-core";
import baseVariant from "@jitl/quickjs-wasmfile-release-sync";
import type {
  QuickJSContext,
  QuickJSWASMModule,
} from "quickjs-emscripten-core";
// Wrangler bundles a sibling .wasm import as a pre-compiled
// WebAssembly.Module — the only form Workers accepts (runtime
// WebAssembly.instantiate from bytes is disallowed by the embedder).
// The file is copied into src/ by the postinstall hook so esbuild's
// node_modules glob exclusion doesn't hide it from the [[rules]] match.
// @ts-expect-error — .wasm has no .d.ts
import wasmModule from "./quickjs.wasm";

const variant = newVariant(baseVariant, {
  wasmModule: wasmModule as WebAssembly.Module,
});

let modulePromise: Promise<QuickJSWASMModule> | null = null;

export async function getQuickJS(): Promise<QuickJSWASMModule> {
  modulePromise ??= newQuickJSWASMModuleFromVariant(variant);
  return modulePromise;
}

/**
 * A persistent QuickJS context that survives across REPL calls.
 * Top-level declarations in one snippet stay in scope for the next.
 */
export class JsSandbox {
  private vm: QuickJSContext;
  private logs: string[] = [];

  private constructor(vm: QuickJSContext) {
    this.vm = vm;
  }

  static async create(): Promise<JsSandbox> {
    const QuickJS = await getQuickJS();
    const vm = QuickJS.newContext();
    const box = new JsSandbox(vm);
    box.installConsole();
    return box;
  }

  /**
   * Evaluate a snippet at global scope so `var`/`function` declarations
   * persist across calls. Returns the value of the last expression.
   */
  eval(code: string): { ok: boolean; result: string; logs: string[] } {
    this.logs = [];
    // QuickJS non-module eval: top-level var/function land on globalThis.
    // let/const do NOT — agent should prefer var for persistence.
    const r = this.vm.evalCode(code);
    if (r.error) {
      const err = this.vm.dump(r.error);
      r.error.dispose();
      return { ok: false, result: formatError(err), logs: this.logs };
    }
    const val = this.vm.dump(r.value);
    r.value.dispose();
    return { ok: true, result: formatValue(val), logs: this.logs };
  }

  /** Replay a snippet without capturing output (hydration path). */
  replay(code: string): void {
    const r = this.vm.evalCode(code);
    if (r.error) r.error.dispose();
    else r.value.dispose();
  }

  /** List global symbols (top-level `var`/`function` declarations). */
  listGlobals(): Array<{ name: string; kind: string; preview: string }> {
    const r = this.vm.evalCode(
      `JSON.stringify(Object.getOwnPropertyNames(globalThis)
        .filter(k => !["console","JSON","Math","Object","Array","String",
          "Number","Boolean","Date","RegExp","Error","Map","Set","Promise",
          "Symbol","Function","undefined","Infinity","NaN","globalThis",
          "parseInt","parseFloat","isNaN","isFinite","encodeURI","decodeURI",
          "encodeURIComponent","decodeURIComponent","Proxy","Reflect",
          "ArrayBuffer","DataView","Uint8Array","Int8Array","Uint16Array",
          "Int16Array","Uint32Array","Int32Array","Float32Array","Float64Array",
          "BigInt","WeakMap","WeakSet","eval","escape","unescape"].includes(k))
        .map(k => {
          const v = globalThis[k];
          const kind = typeof v;
          let preview = kind === "function"
            ? (v.toString().split("\\n")[0].slice(0, 80))
            : JSON.stringify(v);
          if (preview && preview.length > 60) preview = preview.slice(0,59)+"…";
          return {name:k, kind, preview: preview || String(v)};
        }))`,
    );
    if (r.error) {
      r.error.dispose();
      return [];
    }
    const dumped = this.vm.dump(r.value);
    r.value.dispose();
    try {
      return JSON.parse(String(dumped));
    } catch {
      return [];
    }
  }

  dispose(): void {
    this.vm.dispose();
  }

  private installConsole(): void {
    const handle = this.vm.newObject();
    for (const lvl of ["log", "warn", "error"] as const) {
      const fn = this.vm.newFunction(lvl, (...args) => {
        const parts = args.map((a) => {
          const v = this.vm.dump(a);
          return typeof v === "string" ? v : JSON.stringify(v);
        });
        this.logs.push(`[${lvl}] ${parts.join(" ")}`);
      });
      this.vm.setProp(handle, lvl, fn);
      fn.dispose();
    }
    this.vm.setProp(this.vm.global, "console", handle);
    handle.dispose();
  }
}

function formatError(e: unknown): string {
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    const name = String(o.name ?? "Error");
    const msg = String(o.message ?? "");
    const stack = o.stack ? `\n${o.stack}` : "";
    return `${name}: ${msg}${stack}`;
  }
  return String(e);
}

function formatValue(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "function") return "[function]";
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
