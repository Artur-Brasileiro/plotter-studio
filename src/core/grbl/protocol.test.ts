import { describe, expect, it } from "vitest";
import { asciiBytes, LineSplitter, parseLine, stateLabel, workPosition, type StatusReport } from "./protocol";

const status = (line: string): StatusReport => {
  const m = parseLine(line);
  if (m.type !== "status") throw new Error(`não é status: ${line}`);
  return m.report;
};

describe("parseLine", () => {
  it("relatório Idle com WCO → WPos", () => {
    const r = status("<Idle|MPos:-797.500,-345.000,0.000|FS:0,0|WCO:-810.000,-385.000,0.000>");
    expect(r.state).toBe("Idle");
    expect(r.mpos).toEqual({ x: -797.5, y: -345 });
    expect(r.feed).toBe(0);
    expect(r.spindle).toBe(0);
    expect(r.pins).toBe("");
    expect(workPosition(r, undefined)).toEqual({ x: 12.5, y: 40 });
  });

  it("Hold:0 tem subestado", () => {
    const r = status("<Hold:0|MPos:-700.000,-300.000,0.000|FS:0,220>");
    expect(r.state).toBe("Hold");
    expect(r.subState).toBe(0);
    expect(r.spindle).toBe(220);
    expect(stateLabel(r)).toBe("Hold:0");
  });

  it("Alarm com fins de curso", () => {
    expect(status("<Alarm|MPos:0.000,0.000,0.000|FS:0,0|Pn:XY>").pins).toBe("XY");
  });

  it("overrides, F sozinho e Bf", () => {
    const r = status("<Run|MPos:-700.120,-300.000,0.000|F:1500|Ov:110,100,100|Bf:12,100>");
    expect(r.feed).toBe(1500);
    expect(r.overrides).toEqual({ feed: 110, rapid: 100, spindle: 100 });
    expect(r.buffer).toEqual({ blocks: 12, bytes: 100 });
  });

  it("WPos sem WCO: usa o último WCO guardado", () => {
    const r = status("<Run|MPos:-800.000,-380.000,0.000|FS:1000,0>");
    expect(workPosition(r, undefined)).toBeUndefined();
    expect(workPosition(r, { x: -810, y: -385 })).toEqual({ x: 10, y: 5 });
    expect(workPosition(status("<Idle|WPos:1.000,2.000,0.000|FS:0,0>"), undefined)).toEqual({ x: 1, y: 2 });
  });

  it("relatórios como o fork do servo manda: A:S junto do Ov, Home, Hold:1, Door, WPos com Bf", () => {
    // no grbl-servo o PWM nunca desliga, então o campo de acessórios diz "S" até com a caneta em cima
    const ov = status("<Idle|MPos:-1.000,-1.000,0.000|FS:0,0|Ov:100,100,100|A:S>");
    expect(ov.overrides).toEqual({ feed: 100, rapid: 100, spindle: 100 });
    expect(ov.spindle).toBe(0);
    expect(ov.pins).toBe("");
    expect(status("<Home|MPos:-1.000,-1.000,0.000|FS:0,0>").state).toBe("Home");
    expect(stateLabel(status("<Hold:1|MPos:-700.000,-300.000,0.000|FS:1200,220>"))).toBe("Hold:1");
    expect(stateLabel(status("<Door:0|MPos:0.000,0.000,0.000|FS:0,0|Pn:XYD>"))).toBe("Door:0");
    const w = status("<Run|WPos:12.500,40.000,0.000|Bf:9,101|FS:500,220|WCO:-810.000,-385.000,0.000>");
    expect(workPosition(w, undefined)).toEqual({ x: 12.5, y: 40 });
    expect(w.buffer).toEqual({ blocks: 9, bytes: 101 });
    expect(w.wco).toEqual({ x: -810, y: -385 });
  });

  it("o que o GRBL manda fora do roteiro não quebra: [MSG:Pgm End], linha de startup, [OPT:], [HLP:]", () => {
    expect(parseLine("[MSG:Pgm End]")).toEqual({ type: "msg", text: "Pgm End" });
    expect(parseLine("[MSG:Restoring spindle]")).toEqual({ type: "msg", text: "Restoring spindle" });
    expect(parseLine("[OPT:V,15,128]")).toEqual({ type: "feedback", tag: "OPT", body: "V,15,128" });
    expect(parseLine("[VER:1.1h.20190830:]")).toEqual({ type: "feedback", tag: "VER", body: "1.1h.20190830:" });
    expect(parseLine(">G54G21:ok")).toMatchObject({ type: "unknown" }); // não é um "ok" da fila
    expect(parseLine("[HLP:$$ $# $G $I $N $x=val $Nx=line $J=line $SLP $C $X $H ~ ! ? ctrl-x]")).toMatchObject({ type: "feedback", tag: "HLP" });
  });

  it("ok, error, ALARM, banner, MSG, feedback e setting", () => {
    expect(parseLine("ok")).toEqual({ type: "ok" });
    expect(parseLine("error:9")).toEqual({ type: "error", code: 9 });
    expect(parseLine("ALARM:3")).toEqual({ type: "alarm", code: 3 });
    expect(parseLine("Grbl 1.1h ['$' for help]")).toEqual({ type: "banner", version: "1.1h" });
    expect(parseLine("[MSG:'$H'|'$X' to unlock]")).toEqual({ type: "msg", text: "'$H'|'$X' to unlock" });
    expect(parseLine("$110=12000.000")).toEqual({ type: "setting", id: 110, value: "12000.000" });
    expect(parseLine("[G54:-810.000,-385.000,0.000]")).toEqual({ type: "feedback", tag: "G54", body: "-810.000,-385.000,0.000" });
    expect(parseLine("[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]")).toMatchObject({ type: "feedback", tag: "GC" });
    expect(parseLine("<Banana|MPos:0,0,0>")).toMatchObject({ type: "unknown" });
    expect(parseLine("qualquer coisa")).toEqual({ type: "unknown", line: "qualquer coisa" });
  });
});

describe("LineSplitter", () => {
  it("junta pedaços e tira \\r", () => {
    const s = new LineSplitter();
    expect(s.push(asciiBytes("o"))).toEqual([]);
    expect(s.push(asciiBytes("k\r\nerr"))).toEqual(["ok"]);
    expect(s.push(asciiBytes("or:2\n"))).toEqual(["error:2"]);
  });

  it("várias linhas num pedaço só; linhas vazias somem", () => {
    const s = new LineSplitter();
    expect(s.push(asciiBytes("\r\nGrbl 1.1h ['$' for help]\r\n[MSG:x]\r\nok\r\n"))).toEqual(["Grbl 1.1h ['$' for help]", "[MSG:x]", "ok"]);
  });
});
