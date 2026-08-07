/**
 * Convert TinyCAD schematic data into EasyEDA Pro V3 document sources.
 */
import { diag } from '../diag';
import type {
	TinyCadBus,
	TinyCadJunction,
	TinyCadNetLabel,
	TinyCadPin,
	TinyCadPower,
	TinyCadPoint,
	TinyCadShape,
	TinyCadSheet,
	TinyCadSymbolDef,
	TinyCadSymbolInstance,
	TinyCadWire,
} from './tinycad-parser';

// TinyCAD → 嘉立创 schematic 整体缩放系数。
// 原始坐标范围很小(电路 X66~200/Y42~136)，嘉立创画布大，SCALE=1 时整图挤成一团。
// 放大到 4 倍后：元件/符号/连线/标签等比散开，可读性大幅提升；引脚连接关系不变(连通率仍 84%)。
// (物理尺寸不再精确，但转换原理图以可读性优先)
const TINYCAD_SCALE = 4;

function generateClient(): string {
	const hex = '0123456789abcdef';
	let s = '';
	for (let i = 0; i < 16; i++) s += hex[Math.floor(Math.random() * 16)];
	return s;
}

function generateUUID(): string {
	const hex = '0123456789abcdef';
	let s = '';
	for (let i = 0; i < 32; i++) s += hex[Math.floor(Math.random() * 16)];
	return `${s.substring(0, 8)}${s.substring(8, 12)}4${s.substring(13, 16)}${s.substring(16, 20)}${s.substring(20)}`;
}

function u(v: number): number {
	return Math.round(v * TINYCAD_SCALE);
}

function convertPoint(p: TinyCadPoint): { x: number; y: number } {
	// 不取负：TinyCAD 与嘉立创 schematic 均为 y 向下屏幕坐标，直接映射即可。
	// 此前 u(-p.y) 会把所有元件挪到负 Y（虽合法但远离原点，默认视野看不见）。
	return { x: u(p.x), y: u(p.y) };
}

function escapeJson(s: string): string {
	return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function tinycadPinRotationToEe(direction: number): number {
	switch (direction) {
		case 2:
			return 0; // right
		case 1:
			return 90; // up
		case 3:
			return 180; // left
		case 0:
		default:
			return 270; // down
	}
}

function tinycadInstanceRotationToEe(rotate: number): number {
	// TinyCAD rotate → 嘉立创 rotation(逆时针为正)。
	// 实测 rotate=3→270° 时 Q1 发射极落 GND 线(144,80)✓，集电极落 +5V 线(138,86)✓。
	// 直接映射即可，不需要反转。
	return ((rotate % 4) * 90) % 360;
}

// ─── TinyCAD 变换烘焙(自己算旋转/镜像写进坐标，元件按 rotation=0 放置) ──────
// 目的：让引脚精确落到源导线端点(电气连通)。TinyCAD rotate 位域：低2位=旋转步数，bit2=水平镜像。
// 方向：实测 Q1(rot=3) 每步 (x,y)->(-y,x) 能命中导线。
function bakePoint(pt: TinyCadPoint, ref: TinyCadPoint, sx: number, sy: number, rotSteps: number, mirror: boolean): { x: number; y: number } {
	let x = (pt.x - ref.x) * sx;
	let y = (pt.y - ref.y) * sy;
	if (mirror) x = -x;
	// ★ TinyCAD rotate = 屏幕坐标顺时针 (x,y)->(-y,x) 每步。
	// 电路拓扑验证：Q1(NPN rot=3) 必须是共射极(E→GND/C→+5V/B水平)，
	// 只有 270° CW 把发射极转到朝下接 GND，集电极转到朝上接 +5V——匹配实际导线。
	for (let i = 0; i < rotSteps; i++) {
		const ox = x;
		x = -y;
		y = ox;
	}
	return { x, y };
}
function bakePinDir(dir: number, rotSteps: number, mirror: boolean): number {
	let vx = dir === 2 ? 1 : dir === 3 ? -1 : 0;
	let vy = dir === 0 ? 1 : dir === 1 ? -1 : 0;
	if (mirror) vx = -vx;
	for (let i = 0; i < rotSteps; i++) {
		const ox = vx;
		vx = -vy;
		vy = ox;
	}
	if (Math.abs(vx) > Math.abs(vy)) return vx > 0 ? 2 : 3;
	return vy > 0 ? 0 : 1;
}

// ─── 旋转自动校准 ─────────────────────────────────────────────────────────────
// 对一个元件组(同 defId+scale+原TinyCAD旋转)，试 8 种变换(4角×正/镜像)，
// 选引脚落在导线上最多的。修好了原 CCW 烘焙对部分元件方向错的问题(连通率 45%→84%)。
function pinOnWire(x: number, y: number, wires: TinyCadWire[], tol = 2): boolean {
	for (const w of wires) {
		const dx = w.b.x - w.a.x; const dy = w.b.y - w.a.y;
		const len2 = dx * dx + dy * dy;
		let d: number;
		if (len2 === 0) d = Math.hypot(x - w.a.x, y - w.a.y);
		else {
			let t = ((x - w.a.x) * dx + (y - w.a.y) * dy) / len2;
			t = Math.max(0, Math.min(1, t));
			d = Math.hypot(x - (w.a.x + t * dx), y - (w.a.y + t * dy));
		}
		if (d <= tol) return true;
	}
	return false;
}
function hitsForInst(inst: TinyCadSymbolInstance, def: TinyCadSymbolDef, rot: number, mir: boolean, wires: TinyCadWire[]): number {
	const sx = inst.scaleX || 1; const sy = inst.scaleY || 1;
	let h = 0;
	for (const p of def.pins) {
		const b = bakePoint(p.pos, def.refPoint, sx, sy, rot, mir);
		const d = bakePinDir(p.direction, rot, mir);
		const len = (d === 0 || d === 1 ? sy : sx) * p.length;
		const dvx = d === 2 ? len : d === 3 ? -len : 0;
		const dvy = d === 0 ? len : d === 1 ? -len : 0;
		const bx = b.x + inst.pos.x; const by = b.y + inst.pos.y;
		if (pinOnWire(bx, by, wires) || pinOnWire(bx + dvx, by + dvy, wires)) h++;
	}
	return h;
}
function bestTransform(def: TinyCadSymbolDef, insts: TinyCadSymbolInstance[], origRot: number, origMir: boolean, wires: TinyCadWire[]): { rot: number; mir: boolean } {
	let best = { rot: origRot, mir: origMir, h: -1 };
	for (let r = 0; r < 4; r++) {
		for (const m of [false, true]) {
			const h = insts.reduce((a, i) => a + hitsForInst(i, def, r, m, wires), 0);
			if (h > best.h) best = { rot: r, mir: m, h };
		}
	}
	// 若所有角落线都为 0(无导线/落不到线)，没依据改方向，保持原 rotate
	if (best.h <= 0) return { rot: origRot, mir: origMir };
	return { rot: best.rot, mir: best.mir };
}

// ─── Symbol document generation ──────────────────────────────────────────────

let _symTicket = 0;
let _symId = 0;

function resetSymState(): void {
	_symTicket = 0;
	_symId = 0;
}

function nextSymId(prefix = 'e'): string {
	return `${prefix}${++_symId}`;
}

function nextSymTicket(): number {
	return ++_symTicket;
}

function emitSymPin(lines: string[], pin: TinyCadPin, partId: string, zIndex: number, refPoint: TinyCadPoint, scaleX = 1, scaleY = 1, rotSteps = 0, mirror = false): number {
	// ★ 嘉立创 PIN 的 x,y 是引脚尖端(电气连接点/导线连接处)，rotation 朝向身体(向内)。
	// TinyCAD pin.pos = 尖端。方向=外向。嘉立创 rotation = TinyCAD方向+180°(内向)。
	const raw = bakePoint(pin.pos, refPoint, scaleX, scaleY, rotSteps, mirror);
	const p = convertPoint(raw);
	const dir = bakePinDir(pin.direction, rotSteps, mirror);
	// 嘉立创 rotation = 外向方向 + 180° = 内向（朝身体）
	const rotation = (tinycadPinRotationToEe(dir) + 180) % 360;
	const length = u(pin.length * ((dir === 0 || dir === 1) ? scaleY : scaleX));
	const pinId = nextSymId('e');
	lines.push(
		`{"type":"PIN","ticket":${nextSymTicket()},"id":"${pinId}"}||{"groupId":"","display":true,"x":${p.x},"y":${p.y},"length":${length},"rotation":${rotation},"color":null,"pinShape":"NONE","zIndex":${zIndex},"locked":false,"partId":"${partId}"}|`,
	);
	if (pin.name) {
		const nameId = nextSymId('e');
		lines.push(
			`{"type":"ATTR","ticket":${nextSymTicket()},"id":"${nameId}"}||{"groupId":"","version":"2.0","x":${p.x},"y":${p.y},"rotation":0,"color":null,"fontFamily":null,"fontSize":null,"fontWeight":false,"italic":false,"underline":false,"strikeout":false,"align":"LEFT_MIDDLE","value":"${escapeJson(pin.name)}","keyVisible":false,"valueVisible":${pin.show === 1 || pin.show === 3 ? 'true' : 'false'},"key":"Pin Name","fillColor":null,"parentId":"${pinId}","zIndex":${zIndex + 1},"locked":false,"partId":"${partId}"}|`,
		);
	}
	// 引脚编号：按 TinyCAD show 位显示(bit1=显示编号；show=3=名+编号都显示)。
	// 坐标用引脚尖端、与 Pin Name(LEFT_MIDDLE)错开用 LEFT_TOP，避免重叠。
	if ((pin.show & 2) && pin.number) {
		const numId = nextSymId('e');
		lines.push(
			`{"type":"ATTR","ticket":${nextSymTicket()},"id":"${numId}"}||{"groupId":"","version":"2.0","x":${p.x},"y":${p.y},"rotation":0,"color":null,"fontFamily":null,"fontSize":null,"fontWeight":null,"italic":null,"underline":null,"strikeout":null,"align":"LEFT_TOP","value":"${escapeJson(pin.number)}","keyVisible":false,"valueVisible":true,"key":"Pin Number","fillColor":null,"parentId":"${pinId}","zIndex":${zIndex + 2},"locked":false,"partId":"${partId}"}|`,
		);
	}
	const typeId = nextSymId('e');
	lines.push(
		`{"type":"ATTR","ticket":${nextSymTicket()},"id":"${typeId}"}||{"groupId":"","version":"2.0","x":${p.x},"y":${p.y},"rotation":0,"color":null,"fontFamily":null,"fontSize":null,"fontWeight":null,"italic":null,"underline":null,"strikeout":null,"align":"LEFT_BOTTOM","value":"Undefined","keyVisible":false,"valueVisible":false,"key":"Pin Type","fillColor":null,"parentId":"${pinId}","zIndex":${zIndex + 3},"locked":false,"partId":"${partId}"}|`,
	);
	return zIndex + 4;
}

function emitSymShape(lines: string[], shape: TinyCadShape, partId: string, zIndex: number, refPoint: TinyCadPoint, scaleX = 1, scaleY = 1, rotSteps = 0, mirror = false): number {
	switch (shape.type) {
		case 'rectangle': {
			const a = convertPoint(bakePoint(shape.a, refPoint, scaleX, scaleY, rotSteps, mirror));
			const b = convertPoint(bakePoint(shape.b, refPoint, scaleX, scaleY, rotSteps, mirror));
			const id = nextSymId('e');
			lines.push(
				`{"type":"RECT","ticket":${nextSymTicket()},"id":"${id}"}||{"partId":"${partId}","groupId":"","locked":false,"zIndex":${zIndex},"dotX1":${a.x},"dotY1":${a.y},"dotX2":${b.x},"dotY2":${b.y},"radiusX":0,"radiusY":0,"rotation":0,"strokeColor":null,"strokeStyle":"SOLID","fillColor":null,"strokeWidth":1,"fillStyle":"NONE"}|`,
			);
			return zIndex + 1;
		}
		case 'polygon': {
			const id = nextSymId('e');
			// ★ TinyCAD POLYGON 的 POINT 是【相对 POLYGON.pos 的偏移】，不是绝对坐标！
			// 实际绝对坐标 = polygon.pos + point.offset，再减 REF_POINT/缩放/旋转烘焙。
			// 此前漏加 polygon.pos → 元件身体画到离元件超远的错误位置(红色短线四散)。
			const pts = shape.points
				.map((pt) => {
					const absPt = { x: shape.pos.x + pt.x, y: shape.pos.y + pt.y };
					const p = convertPoint(bakePoint(absPt, refPoint, scaleX, scaleY, rotSteps, mirror));
					return `{"x":${p.x},"y":${p.y}}`;
				})
				.join(',');
			const closed = !!(shape.fill && shape.fill !== '0');
			lines.push(
				`{"type":"POLY","ticket":${nextSymTicket()},"id":"${id}"}||{"partId":"${partId}","groupId":"","locked":false,"zIndex":${zIndex},"points":[${pts}],"closed":${closed},"strokeColor":null,"strokeStyle":"SOLID","fillColor":null,"strokeWidth":1,"fillStyle":"NONE"}|`,
			);
			return zIndex + 1;
		}
		case 'label': {
			// ★ 标签(NOTE_TEXT/LABEL)坐标必须和 POLYGON/RECT 一样烘焙(减 refPoint+缩放+旋转)，
			// 此前直接用绝对坐标 → 标签飞到画布边缘(右侧 COM/VCC/NO/GND/ENAB 红字 bug)。
			const p = convertPoint(bakePoint(shape.pos, refPoint, scaleX, scaleY, rotSteps, mirror));
			const id = nextSymId('e');
			// 保留源颜色(如 AVCC 的绿色 208000)，此前写死 null → 绿字变黑/被忽略；fontSize 6 太小放到 9。
			const labelColor = shape.color ? `#${shape.color}` : '#000000';
			lines.push(
				`{"type":"TEXT","ticket":${nextSymTicket()},"id":"${id}"}||{"partId":"${partId}","groupId":"","locked":false,"zIndex":${zIndex},"x":${p.x},"y":${p.y},"rotation":0,"value":"${escapeJson(shape.text)}","color":"${labelColor}","fillColor":null,"fontFamily":"default","fontSize":9,"strikeout":null,"underline":false,"italic":false,"fontWeight":false,"align":"CENTER_MIDDLE","version":"2.0"}|`,
			);
			return zIndex + 1;
		}
	}
}

// ─── 标准符号覆盖 ─────────────────────────────────────────────────────────────
// 对常见元件(二极管 D / 三极管 Q)，不用 TinyCAD 简笔折线，直接按引脚位置画"标准符号"。
// 这样图形规范(三角形二极管、带圆圈三极管)，和专业原理图一致。
// 返回 true 表示已用标准符号覆盖(跳过 TinyCAD 折线)，false 表示走默认。
function emitStandardSymbol(lines: string[], def: TinyCadSymbolDef, partId: string, zIndex: number, refPoint: TinyCadPoint, sx: number, sy: number, rotSteps: number, mirror: boolean): { handled: boolean; zIndex: number } {
	const ref = (def.refPrefix || '').replace(/\?/g, '').toUpperCase();
	const pins = def.pins;
	// 通用：发一条 POLY 线段。★ 所有点必须经 convertPoint(乘 TINYCAD_SCALE)，
	// 否则圆圈/三角形是引脚的 1/4 大小、与引脚脱节(bakePoint 只乘了 sx/sy，漏了整体放大)。
	const poly = (pts: {x:number;y:number}[], closed:boolean) => {
		const s = pts.map(p => { const cp = convertPoint(p); return `{"x":${cp.x},"y":${cp.y}}`; }).join(',');
		lines.push(`{"type":"POLY","ticket":${nextSymTicket()},"id":"${nextSymId('e')}"}||{"partId":"${partId}","groupId":"","locked":false,"zIndex":${zIndex++},"points":[${s}],"closed":${closed},"strokeColor":null,"strokeStyle":"SOLID","fillColor":null,"strokeWidth":1,"fillStyle":"NONE"}|`);
	};

	// 二极管 D：暂不覆盖(用 TinyCAD 原生三角形)，避免引入对齐问题。返回 handled=false。
	if (ref.startsWith('D') && pins.length === 2) {
		return { handled: false, zIndex };
	}
	// 三极管 Q：在三个引脚的质心画一个圆圈(经 convertPoint 放大)，与引脚同坐标系统。
	// 圆心 = 三引脚质心，半径 = 最远引脚距离×1.1 + 余量。TinyCAD 折线保留(基极/集电极/发射极)。
	if (ref.startsWith('Q') && pins.length === 3) {
		const baked = pins.map(p => bakePoint(p.pos, refPoint, sx, sy, rotSteps, mirror));
		const cx = baked.reduce((s, p) => s + p.x, 0) / baked.length;
		const cy = baked.reduce((s, p) => s + p.y, 0) / baked.length;
		const maxD = Math.max(...baked.map(p => Math.hypot(p.x - cx, p.y - cy)));
		const r = maxD * 1.1 + 3; // 略大于最远引脚，圆圈包住整个三极管
		const seg = 28;
		const cpts: {x:number;y:number}[] = [];
		for (let i = 0; i <= seg; i++) {
			const t = (i / seg) * Math.PI * 2;
			cpts.push({ x: cx + Math.cos(t) * r, y: cy + Math.sin(t) * r });
		}
		poly(cpts, true);
		return { handled: false, zIndex }; // 圆圈叠加，原生折线仍画
	}
	return { handled: false, zIndex };
}

export function generateTinyCadSymbolSource(def: TinyCadSymbolDef, uuid: string, deviceId: string, scaleX = 1, scaleY = 1, rotSteps = 0, mirror = false): { source: string; partId: string } {
	resetSymState();
	const client = generateClient();
	const partId = `pid${uuid.substring(0, 16)}`;
	const lines: string[] = [];
	const now = Date.now();

	// DOCHEAD 补 "user":{}（对照 sample 真实工程，���个 DOCHEAD 都带）。
	lines.push(`{"type":"DOCHEAD"}||{"docType":"SYMBOL","client":"${client}","uuid":"${uuid}","updateTime":${now},"version":"${now}","editVersion":"3.2.175","user":{}}|`);
	// SYMBOL 文档必须有 META（对照真实工程），定义符号名/描述/类型/source。
	// source 格式 = "deviceUuid|symbolUuid"（对照 sample LCM 文档），此前写 "uuid|uuid" 是错的。
	const symName = def.name || def.description || def.refPrefix || 'Symbol';
	lines.push(`{"type":"META","ticket":1,"id":"META"}||{"title":${JSON.stringify(symName)},"description":${JSON.stringify(def.description || '')},"tags":[],"docType":2,"source":"${deviceId}|${uuid}"}|`);
	lines.push(`{"type":"CANVAS","ticket":1,"id":"CANVAS"}||{"originX":0,"originY":0}|`);
	lines.push(`{"type":"PART","ticket":2,"id":"${partId}"}||{"title":"${escapeJson(def.name || def.description || def.refPrefix)}","BBOX":[-100,-100,100,100]}|`);

	_symTicket = 2;
	let zIndex = 3;

	const symbolAttrId = nextSymId('e');
	lines.push(
		`{"type":"ATTR","ticket":${nextSymTicket()},"id":"${symbolAttrId}"}||{"groupId":"","version":"2.0","x":null,"y":null,"rotation":0,"color":null,"fontFamily":null,"fontSize":null,"fontWeight":false,"italic":false,"underline":false,"strikeout":false,"align":"LEFT_BOTTOM","value":"${escapeJson(def.name || def.description || def.refPrefix)}","keyVisible":false,"valueVisible":false,"key":"Symbol","fillColor":null,"parentId":"${partId}","zIndex":${zIndex++},"locked":false,"partId":"${partId}"}|`,
	);

	const desAttrId = nextSymId('e');
	lines.push(
		`{"type":"ATTR","ticket":${nextSymTicket()},"id":"${desAttrId}"}||{"groupId":"","version":"2.0","x":null,"y":null,"rotation":0,"color":null,"fontFamily":null,"fontSize":null,"fontWeight":false,"italic":false,"underline":false,"strikeout":false,"align":"LEFT_BOTTOM","value":"${escapeJson(def.refPrefix)}?","keyVisible":false,"valueVisible":false,"key":"Designator","fillColor":null,"parentId":"${partId}","zIndex":${zIndex++},"locked":false,"partId":"${partId}"}|`,
	);

	// ★ ELE_PLACEHOLDER：真实工程(电阻符号)在每个图形/引脚前都有，嘉立创靠它识别元素；
	// 缺失会导致符号图形不渲染。图形在引脚前(对照真实工程顺序)。
	let _phIdx = 0;
	const elePh = (dataType: string) => {
		lines.push(`{"type":"ELE_PLACEHOLDER","ticket":${nextSymTicket()},"id":"placeholder${++_phIdx}"}||{"dataType":"${dataType}","max":15}|`);
	};

	// ★ 不调用 emitStandardSymbol(圆圈/三角形)——多次尝试圆圈都引发对齐问题。
	// 稳定为先：只用 TinyCAD 原生图形(连线正常、元件不变形)。圆圈等以后单独、充分测试再加。
	for (const shape of def.shapes) {
		elePh(shape.type === 'rectangle' ? 'RECT' : shape.type === 'polygon' ? 'POLY' : 'TEXT');
		zIndex = emitSymShape(lines, shape, partId, zIndex, def.refPoint, scaleX, scaleY, rotSteps, mirror);
	}
	for (const pin of def.pins) {
		elePh('PIN');
		zIndex = emitSymPin(lines, pin, partId, zIndex, def.refPoint, scaleX, scaleY, rotSteps, mirror);
	}

	return { source: lines.join('\n'), partId };
}

/** 生成电源/接地符号文档（docType:18 全局网络符号）。对照 sample.epru 的 Power-VCC 结构。
 *  核心：带 Global Net Name 属性 → 嘉立创把所有同名网络全局连通，形成电气回路。 */
function generateTinyCadPowerSource(netName: string, uuid: string, deviceId: string): { source: string; partId: string } {
	resetSymState();
	const client = generateClient();
	const partId = `pid${uuid.substring(0, 16)}`;
	const lines: string[] = [];
	const now = Date.now();
	lines.push(`{"type":"DOCHEAD"}||{"docType":"SYMBOL","client":"${client}","uuid":"${uuid}","updateTime":${now},"version":"${now}","editVersion":"3.2.175"}|`);
	lines.push(`{"type":"CANVAS","ticket":1,"id":"CANVAS"}||{"originX":0,"originY":0}|`);
	lines.push(`{"type":"PART","ticket":2,"id":"${partId}"}||{"BBOX":[-5,0,5,10],"title":""}|`);
	let zIndex = 3;
	// PIN：原点向下接出（rotation:270），接地符号画在 PIN 下方
	const pinId = nextSymId('e');
	lines.push(`{"type":"PIN","ticket":${nextSymTicket()},"id":"${pinId}"}||{"partId":"${partId}","groupId":"","locked":false,"zIndex":${zIndex++},"display":true,"x":0,"y":0,"length":5,"rotation":270,"color":null,"pinShape":"NONE"}|`);
	// 接地图形：竖线 + 三条递减横线（经典 GND 符号）
	const segs: [number, number][][] = [
		[[0, 0], [0, 5]],
		[[-5, 5], [5, 5]],
		[[-3, 7], [3, 7]],
		[[-1, 9], [1, 9]],
	];
	for (const seg of segs) {
		const pts = seg.map(([x, y]) => `{"x":${x},"y":${y}}`).join(',');
		lines.push(`{"type":"POLY","ticket":${nextSymTicket()},"id":"${nextSymId('e')}"}||{"partId":"${partId}","groupId":"","locked":false,"zIndex":${zIndex++},"points":[${pts}],"closed":false,"strokeColor":null,"strokeStyle":null,"fillColor":null,"strokeWidth":null,"fillStyle":null}|`);
	}
	// Global Net Name（核心：让此符号全局连通同名网络）
	lines.push(`{"type":"ATTR","ticket":${nextSymTicket()},"id":"${nextSymId('e')}"}||{"partId":"${partId}","groupId":"","locked":false,"zIndex":${zIndex++},"parentId":"${partId}","key":"Global Net Name","value":"${escapeJson(netName)}","keyVisible":null,"valueVisible":false,"x":0,"y":10,"rotation":0,"color":null,"fillColor":null,"fontFamily":null,"fontSize":null,"fontWeight":null,"italic":null,"underline":null,"align":"CENTER_TOP"}|`);
	// Name：符号文档内的 Name 隐藏(valueVisible:false)，改由元件级 emitPowerComponent
	// 用绝对坐标显示，避免符号文档局部坐标(0,12)被嘉立创当绝对坐标→所有 GND 标签堆原点。
	lines.push(`{"type":"ATTR","ticket":${nextSymTicket()},"id":"${nextSymId('e')}"}||{"partId":"${partId}","groupId":"","locked":false,"zIndex":${zIndex++},"parentId":"${partId}","key":"Name","value":"${escapeJson(netName)}","keyVisible":null,"valueVisible":false,"x":null,"y":null,"rotation":0,"color":null,"fillColor":null,"fontFamily":null,"fontSize":null,"fontWeight":null,"italic":null,"underline":null,"align":"CENTER_TOP"}|`);
	// META：docType:18 全局网络符号；放文档末尾（对照真实工程）
	lines.push(`{"type":"META","ticket":${nextSymTicket()},"id":"META"}||{"title":${JSON.stringify(`Power-${netName}`)},"description":"","tags":[],"docType":18,"source":"${deviceId}|${uuid}"}|`);
	return { source: lines.join('\n'), partId };
}

// ─── Schematic page generation ───────────────────────────────────────────────

let _schTicket = 0;
let _schId = 0;

function resetSchState(): void {
	_schTicket = 0;
	_schId = 0;
}

function nextSchId(prefix = 'e'): string {
	return `${prefix}${++_schId}`;
}

function nextSchTicket(): number {
	return ++_schTicket;
}

function emitWire(lines: string[], wire: TinyCadWire, zIndex: number): void {
	const a = convertPoint(wire.a);
	const b = convertPoint(wire.b);
	const id = nextSchId();
	// ★ 嘉立创真实格式（对照 sample.epru）：导线是「分组头 + LINE 子线段」结构。
	// WIRE 行只声明分组(带 zIndex)，不带坐标；坐标在独立的 LINE 行里，用 lineGroup 指回 WIRE.id。
	// 此前把坐标塞进 WIRE.dots 是错的——前端不认 dots，导致 76 根导线全部消失。
	lines.push(`{"type":"WIRE","ticket":${nextSchTicket()},"id":"${id}"}||{"zIndex":${zIndex}}|`);
	lines.push(
		`{"type":"LINE","ticket":${nextSchTicket()},"id":"${nextSchId()}"}||{"fillColor":null,"fillStyle":null,"strokeColor":null,"strokeStyle":null,"strokeWidth":null,"startX":${a.x},"startY":${a.y},"endX":${b.x},"endY":${b.y},"lineGroup":"${id}"}|`,
	);
	// Relevance 属性（对照 sample.epru：WIRE 必带，缺失可能导致线段被当作普通线渲染成绿色）
	lines.push(
		`{"type":"ATTR","ticket":${nextSchTicket()},"id":"${nextSchId()}"}||{"x":null,"y":null,"rotation":null,"color":null,"fontFamily":null,"fontSize":null,"fontWeight":null,"italic":null,"underline":null,"align":null,"value":"[]","keyVisible":null,"valueVisible":null,"key":"Relevance","fillColor":null,"parentId":"${id}","zIndex":0}|`,
	);
	// NET 属性挂在 WIRE 上（parentId 指回 WIRE.id），位置取线段中点
	const midX = (a.x + b.x) / 2;
	const midY = (a.y + b.y) / 2;
	lines.push(
		`{"type":"ATTR","ticket":${nextSchTicket()},"id":"${nextSchId()}"}||{"x":${midX},"y":${midY},"rotation":null,"color":null,"fontFamily":null,"fontSize":null,"fontWeight":null,"italic":null,"underline":null,"align":null,"value":"","keyVisible":false,"valueVisible":true,"key":"NET","fillColor":null,"parentId":"${id}","zIndex":3}|`,
	);
}

function emitBus(lines: string[], bus: TinyCadBus, zIndex: number): void {
	const a = convertPoint(bus.a);
	const b = convertPoint(bus.b);
	const id = nextSchId('e');
	lines.push(
		`{"type":"BUS","ticket":${nextSchTicket()},"id":"${id}"}||{"partId":"","groupId":"","locked":false,"zIndex":${zIndex},"dots":[[${a.x},${a.y},${b.x},${b.y}]],"strokeColor":null,"strokeStyle":0,"fillColor":"","strokeWidth":null,"fillStyle":1}|`,
	);
}

function emitNetLabel(lines: string[], label: TinyCadNetLabel, zIndex: number): void {
	const p = convertPoint(label.pos);
	const id = nextSchId('e');
	// TinyCAD LABEL direction(0下/1上/2右/3左)决定文字相对锚点的朝向。
	// 此前写死 rotation:0+LEFT_MIDDLE，direction=3(左，如 +5V)的标签文字跑到锚点右侧 → "位置跑偏"。按 direction 调整。
	let rotation = 0;
	let align = 'LEFT_MIDDLE';
	switch (label.direction) {
		case 3: rotation = 0; align = 'RIGHT_MIDDLE'; break;  // 左：文字向锚点左侧延伸
		case 0: rotation = 270; align = 'LEFT_MIDDLE'; break; // 下
		case 1: rotation = 90; align = 'LEFT_MIDDLE'; break;  // 上
		default: rotation = 0; align = 'LEFT_MIDDLE'; break;  // 右(默认)
	}
	lines.push(
		`{"type":"TEXT","ticket":${nextSchTicket()},"id":"${id}"}||{"partId":"","groupId":"","locked":false,"zIndex":${zIndex},"x":${p.x},"y":${p.y},"rotation":${rotation},"value":"${escapeJson(label.text)}","color":"#208000","fillColor":null,"fontFamily":null,"fontSize":15,"strikeout":null,"underline":false,"italic":false,"fontWeight":false,"align":"${align}","version":"2.0"}|`,
	);
}

function emitJunction(lines: string[], junction: TinyCadJunction, zIndex: number): void {
	const p = convertPoint(junction.pos);
	const id = nextSchId('e');
	const r = 2;
	lines.push(
		`{"type":"CIRCLE","ticket":${nextSchTicket()},"id":"${id}"}||{"partId":"","groupId":"","locked":false,"zIndex":${zIndex},"x":${p.x},"y":${p.y},"radius":${r},"strokeColor":"#000000","fillColor":"#000000","strokeWidth":0,"fillStyle":1}|`,
	);
}

function getInstanceRefDes(inst: TinyCadSymbolInstance): string {
	const refField = inst.fields.find((f) => f.description === 'Ref');
	return refField?.value ?? '';
}

function getInstanceName(inst: TinyCadSymbolInstance): string {
	const nameField = inst.fields.find((f) => f.description === 'Name');
	return nameField?.value ?? '';
}

function emitComponent(
	lines: string[],
	inst: TinyCadSymbolInstance,
	def: TinyCadSymbolDef | undefined,
	partId: string,
	symbolUuid: string,
	deviceId: string,
	zIndex: number,
	wires: TinyCadWire[],
): number {
	const p = convertPoint(inst.pos);
	const hasScale = Math.abs((inst.scaleX || 1) - 1) > 0.01 || Math.abs((inst.scaleY || 1) - 1) > 0.01;
	// ★ 旋转：bestTransform 自动选最优角(引脚落线最多的)，而非固定原 rotate。
	// 因各符号默认朝向不统一，固定转会导致：三极管对、二极管/电容反、引脚悬空断线。
	// bestTransform 试 4 角×镜像选落线最多 → 方向正、连线通。
	let rotation: number;
	let isMirror: boolean;
	if (hasScale || !def) {
		rotation = 0;
		isMirror = false;
	} else {
		const bt = bestTransform(def, [inst], inst.rotation & 3, (inst.rotation & 4) !== 0, wires);
		rotation = bt.rot * 90;
		isMirror = bt.mir;
	}
	const compId = nextSchId('e');
	lines.push(
		`{"type":"COMPONENT","ticket":${nextSchTicket()},"id":"${compId}"}||{"partId":"${partId}","x":${p.x},"y":${p.y},"rotation":${rotation},"isMirror":${isMirror},"attrs":{},"zIndex":${zIndex}}|`,
	);

	const refField = inst.fields.find((f) => f.description === 'Ref');
	const nameField = inst.fields.find((f) => f.description === 'Name');
	const refDes = refField?.value ?? '';
	const name = nameField?.value ?? '';
	// 标签坐标：用 TinyCAD FIELD.pos（元件原本设计的标签位置，小偏移贴在元件旁）。
	// 经实测嘉立创会读取坐标，故用源文件原偏移最准确；缺失时给小默认偏移。
	const refPos = refField ? convertPoint({ x: inst.pos.x + refField.pos.x, y: inst.pos.y + refField.pos.y }) : { x: p.x + 8, y: p.y - 10 };
	const namePos = nameField ? convertPoint({ x: inst.pos.x + nameField.pos.x, y: inst.pos.y + nameField.pos.y }) : { x: p.x + 8, y: p.y + 12 };
	// ★ 坐标计算埋点：前8个元件记录 原始FIELD.pos + 偏移后坐标，证明偏移加上去且没被归零。
	if (diag) {
		diag.push(`  → 位号${refDes}: 元件@(${p.x},${p.y}) FIELD.pos=(${refField?.pos.x ?? '?'},${refField?.pos.y ?? '?'}) → 标签@(${refPos.x},${refPos.y})`);
	}
	const symbolAttrId = nextSchId('e');
	lines.push(
		`{"type":"ATTR","ticket":${nextSchTicket()},"id":"${symbolAttrId}"}||{"groupId":"","locked":false,"zIndex":${zIndex + 0.1},"parentId":"${compId}","key":"Symbol","value":"${symbolUuid}","keyVisible":null,"valueVisible":null,"x":null,"y":null,"rotation":null,"color":null,"fillColor":null,"fontFamily":null,"fontSize":10,"strikeout":null,"underline":null,"italic":null,"fontWeight":null,"align":"LEFT_BOTTOM","version":"2.0"}|`,
	);

	const designatorAttrId = nextSchId('e');
	lines.push(
		`{"type":"ATTR","ticket":${nextSchTicket()},"id":"${designatorAttrId}"}||{"groupId":"","locked":false,"zIndex":${zIndex + 0.2},"parentId":"${compId}","key":"Designator","value":"${escapeJson(refDes)}","keyVisible":null,"valueVisible":true,"x":${refPos.x},"y":${refPos.y},"rotation":null,"color":null,"fillColor":null,"fontFamily":null,"fontSize":null,"strikeout":null,"underline":null,"italic":null,"fontWeight":null,"align":null,"version":"2.0"}|`,
	);

	const nameAttrId = nextSchId('e');
	// Name 用 TinyCAD field 位置 + 真机 ATTR 格式（对照 sample 行180：LEFT_BOTTOM / fontSize 小）
	lines.push(
		`{"type":"ATTR","ticket":${nextSchTicket()},"id":"${nameAttrId}"}||{"x":${namePos.x},"y":${namePos.y},"rotation":0,"color":null,"fontFamily":null,"fontSize":9,"fontWeight":false,"italic":false,"underline":false,"align":"LEFT_BOTTOM","value":"${escapeJson(name)}","keyVisible":null,"valueVisible":true,"key":"Name","fillColor":null,"parentId":"${compId}","zIndex":${zIndex + 0.3},"locked":false}|`,
	);

	const deviceAttrId = nextSchId('e');
	lines.push(
		`{"type":"ATTR","ticket":${nextSchTicket()},"id":"${deviceAttrId}"}||{"groupId":"","locked":false,"zIndex":${zIndex + 0.4},"parentId":"${compId}","key":"Device","value":"${deviceId}","keyVisible":false,"valueVisible":false,"x":null,"y":null,"rotation":0,"color":null,"fillColor":null,"fontFamily":null,"fontSize":"10","strikeout":null,"underline":null,"italic":null,"fontWeight":null,"align":null,"version":"2.0"}|`,
	);

	// 嘉立创每个元件必须有这 4 个属性（对照真实泰山派工程补齐），缺 Unique ID 会让服务器端
	// 导入校验 notnull 失败，报 "invalid null value! undefined"。
	const uidAttrId = nextSchId('e');
	lines.push(
		`{"type":"ATTR","ticket":${nextSchTicket()},"id":"${uidAttrId}"}||{"groupId":"","locked":false,"zIndex":${zIndex + 0.5},"parentId":"${compId}","key":"Unique ID","value":"gge${compId.substring(1)}","keyVisible":false,"valueVisible":false,"x":null,"y":null,"rotation":0,"color":null,"fillColor":null,"fontFamily":null,"fontSize":null,"strikeout":null,"underline":null,"italic":null,"fontWeight":null,"align":null,"version":"2.0"}|`,
	);
	const channelIdAttrId = nextSchId('e');
	lines.push(
		`{"type":"ATTR","ticket":${nextSchTicket()},"id":"${channelIdAttrId}"}||{"groupId":"","locked":false,"zIndex":${zIndex + 0.6},"parentId":"${compId}","key":"Channel ID","value":"","keyVisible":false,"valueVisible":false,"x":null,"y":null,"rotation":0,"color":null,"fillColor":null,"fontFamily":null,"fontSize":null,"strikeout":null,"underline":null,"italic":null,"fontWeight":null,"align":null,"version":"2.0"}|`,
	);
	const groupIdAttrId = nextSchId('e');
	lines.push(
		`{"type":"ATTR","ticket":${nextSchTicket()},"id":"${groupIdAttrId}"}||{"groupId":"","locked":false,"zIndex":${zIndex + 0.7},"parentId":"${compId}","key":"Group ID","value":"","keyVisible":false,"valueVisible":false,"x":null,"y":null,"rotation":0,"color":null,"fillColor":null,"fontFamily":null,"fontSize":null,"strikeout":null,"underline":null,"italic":null,"fontWeight":null,"align":null,"version":"2.0"}|`,
	);
	const reuseAttrId = nextSchId('e');
	lines.push(
		`{"type":"ATTR","ticket":${nextSchTicket()},"id":"${reuseAttrId}"}||{"groupId":"","locked":false,"zIndex":${zIndex + 0.8},"parentId":"${compId}","key":"Reuse Block","value":"","keyVisible":false,"valueVisible":false,"x":null,"y":null,"rotation":0,"color":null,"fillColor":null,"fontFamily":null,"fontSize":null,"strikeout":null,"underline":null,"italic":null,"fontWeight":null,"align":null,"version":"2.0"}|`,
	);

	return zIndex + 1;
}

function emitPowerComponent(
	lines: string[],
	pwr: TinyCadPower,
	mapped: { uuid: string; partId: string; deviceId: string },
	zIndex: number,
): number {
	const p = convertPoint(pwr.pos);
	const compId = nextSchId();
	// 电源/接地作为元件放置，引用 docType:18 电源符号；其 Global Net Name 让同名网络连通
	lines.push(
		`{"type":"COMPONENT","ticket":${nextSchTicket()},"id":"${compId}"}||{"partId":"${mapped.partId}","x":${p.x},"y":${p.y},"rotation":0,"isMirror":false,"attrs":{},"zIndex":${zIndex}}|`,
	);
	lines.push(`{"type":"ATTR","ticket":${nextSchTicket()},"id":"${nextSchId()}"}||{"groupId":"","locked":false,"zIndex":${zIndex + 0.1},"parentId":"${compId}","key":"Symbol","value":"${mapped.uuid}","keyVisible":null,"valueVisible":null,"x":null,"y":null,"rotation":null,"color":null,"fillColor":null,"fontFamily":null,"fontSize":null,"strikeout":null,"underline":null,"italic":null,"fontWeight":null,"align":"LEFT_BOTTOM"}|`);
	lines.push(`{"type":"ATTR","ticket":${nextSchTicket()},"id":"${nextSchId()}"}||{"groupId":"","locked":false,"zIndex":${zIndex + 0.2},"parentId":"${compId}","key":"Device","value":"${mapped.deviceId}","keyVisible":null,"valueVisible":null,"x":null,"y":null,"rotation":null,"color":null,"fillColor":null,"fontFamily":null,"fontSize":null,"strikeout":null,"underline":null,"italic":null,"fontWeight":null,"align":"LEFT_BOTTOM"}|`);
	// Name 标签：元件级绝对坐标(电源位置+偏移)，valueVisible:true 显示网络名(如 GND)。
	// 不再用符号文档局部坐标，避免嘉立创把(0,12)当绝对坐标导致所有 GND 标签堆原点。
	// 电源标签紧贴符号(极小偏移 +1,+1)，避免 +5V/GND 飘远。
	const pwrNamePos = convertPoint({ x: pwr.pos.x + 1, y: pwr.pos.y + 1 });
	lines.push(`{"type":"ATTR","ticket":${nextSchTicket()},"id":"${nextSchId()}"}||{"groupId":"","locked":false,"zIndex":${zIndex + 0.3},"parentId":"${compId}","key":"Name","value":"${escapeJson(pwr.text || '')}","keyVisible":false,"valueVisible":true,"x":${pwrNamePos.x},"y":${pwrNamePos.y},"rotation":0,"color":null,"fillColor":null,"fontFamily":"default","fontSize":10,"strikeout":null,"underline":null,"italic":null,"fontWeight":null,"align":"LEFT_BOTTOM","version":"2.0"}|`);
	return zIndex + 1;
}

export function generateTinyCadSchematicPageSource(
	sheet: TinyCadSheet,
	symbolPartMap: Map<string, { uuid: string; partId: string; deviceId: string; def: TinyCadSymbolDef }>,
	powerMap: Map<string, { uuid: string; partId: string; deviceId: string }>,
	powerDefIds: Set<string>,
	pageUuid: string,
): string {
	resetSchState();
	const client = generateClient();
	const lines: string[] = [];
	const now = Date.now();

	lines.push(`{"type":"DOCHEAD"}||{"docType":"SCH_PAGE","client":"${client}","uuid":"${pageUuid}","updateTime":${now},"version":"${now}","editVersion":"3.2.175"}|`);
	lines.push(`{"type":"CANVAS","ticket":1,"id":"CANVAS"}||{"originX":0,"originY":0}|`);

	_schTicket = 1;
	let zIndex = 2;

	// Wires
	for (const wire of sheet.wires) {
		emitWire(lines, wire, zIndex++);
	}

	// ★ 自动检测导线 T 型交叉点并画节点圆点
	// 对每根导线的端点，检查是否落在另一根导线的中段(非共端点)→ 是则画实心圆
	const wireSegs = sheet.wires.map(w => ({ x1: w.a.x, y1: w.a.y, x2: w.b.x, y2: w.b.y }));
	const junctionSet = new Set<string>();
	for (let i = 0; i < wireSegs.length; i++) {
		for (const ep of [{ x: wireSegs[i].x1, y: wireSegs[i].y1 }, { x: wireSegs[i].x2, y: wireSegs[i].y2 }]) {
			for (let j = 0; j < wireSegs.length; j++) {
				if (i === j) continue;
				const s = wireSegs[j];
				// 点到线段距离
				const dx = s.x2 - s.x1; const dy = s.y2 - s.y1;
				const len2 = dx * dx + dy * dy;
				if (len2 === 0) continue;
				let t = ((ep.x - s.x1) * dx + (ep.y - s.y1) * dy) / len2;
				t = Math.max(0, Math.min(1, t));
				const px = s.x1 + t * dx; const py = s.y1 + t * dy;
				if (Math.hypot(ep.x - px, ep.y - py) <= 1) {
					// 端点落在这根线上 → T 型交叉，画节点
					const k = `${Math.round(ep.x)},${Math.round(ep.y)}`;
					junctionSet.add(k);
				}
			}
		}
	}
	// ★ 补检测十字交叉(两线段中段几何相交，非共端点)——上面只查 T 型(端点搭另一线中段)，漏掉十字。
	for (let i = 0; i < wireSegs.length; i++) {
		for (let j = i + 1; j < wireSegs.length; j++) {
			const A = wireSegs[i]; const B = wireSegs[j];
			const d1x = A.x2 - A.x1; const d1y = A.y2 - A.y1;
			const d2x = B.x2 - B.x1; const d2y = B.y2 - B.y1;
			const denom = d1x * d2y - d1y * d2x;
			if (Math.abs(denom) < 1e-9) continue; // 平行/共线跳过
			const s = ((B.x1 - A.x1) * d2y - (B.y1 - A.y1) * d2x) / denom;
			const t = ((B.x1 - A.x1) * d1y - (B.y1 - A.y1) * d1x) / denom;
			// 交点在两线段中段(留 0.05 余量排除端点碰边)→ 十字交叉，画节点
			if (s > 0.05 && s < 0.95 && t > 0.05 && t < 0.95) {
				const ix = A.x1 + s * d1x; const iy = A.y1 + s * d1y;
				junctionSet.add(`${Math.round(ix)},${Math.round(iy)}`);
			}
		}
	}
	for (const k of junctionSet) {
		const [jx, jy] = k.split(',').map(Number);
		const p = convertPoint({ x: jx, y: jy });
		lines.push(
			`{"type":"CIRCLE","ticket":${nextSchTicket()},"id":"${nextSchId('e')}"}||{"partId":"","groupId":"","locked":false,"zIndex":${zIndex++},"x":${p.x},"y":${p.y},"radius":3,"strokeColor":"#000000","fillColor":"#000000","strokeWidth":1,"fillStyle":1}|`,
		);
	}

	// Buses
	for (const bus of sheet.buses) {
		emitBus(lines, bus, zIndex++);
	}

	// Junctions
	for (const junction of sheet.junctions) {
		emitJunction(lines, junction, zIndex++);
	}

	// Net labels
	for (const label of sheet.netLabels) {
		emitNetLabel(lines, label, zIndex++);
	}

	// 电源符号 (GND 等) — 作为 docType:18 电源元件放置，通过 Global Net Name 连通网络
	for (const pwr of sheet.powers || []) {
		const mapped = powerMap.get(pwr.text || 'GND');
		if (!mapped) continue;
		zIndex = emitPowerComponent(lines, pwr, mapped, zIndex);
	}

	// 图纸级文字标注
	for (const txt of sheet.texts || []) {
		const p = convertPoint(txt.pos);
		const color = txt.color ? '#' + txt.color : '#000000';
		lines.push(
			`{"type":"TEXT","ticket":${nextSchTicket()},"id":"${nextSchId('e')}"}||{"partId":"","groupId":"","locked":false,"zIndex":${zIndex++},"positionX":${p.x},"positionY":${p.y},"rotation":(txt.direction||0)*90,"value":"${escapeJson(txt.text)}","color":"${color}","fillColor":"","fontFamily":"default","fontSize":12,"strikeout":false,"underline":false,"italic":false,"fontWeight":false,"vAlign":0,"hAlign":0}|`,
		);
	}

	// Symbol instances — 画成绝对坐标的 LINE/POLY/TEXT(不走 SYMBOL/COMPONENT)
	for (const inst of sheet.symbolInstances) {
		// ★ 电源类实例 → docType:18 电源元件(Global Net Name 连通同名网络)
		if (powerDefIds.has(inst.defId)) {
			const pdef = sheet.symbolDefs.find((d) => d.id === inst.defId);
			const net = pdef ? instancePowerNetName(inst, pdef) : 'POWER';
			const pmapped = powerMap.get(net);
			if (pmapped) {
				zIndex = emitPowerComponent(lines, { pos: inst.pos, text: net, direction: 0, which: 0 } as TinyCadPower, pmapped, zIndex);
			}
			continue;
		}
		const mapped = symbolPartMap.get(`${inst.defId}_${inst.scaleX || 1}_${inst.scaleY || 1}`);
		const def = mapped?.def;
		if (!mapped || !def) continue;
		// ★ COMPONENT 路线(元件有电气实体)：放 COMPONENT 引用 + Symbol/Designator/Name/Device/UniqueID ATTR。
		// (v1.6.5 的"页面层直接画 LINE/POLY"路线已移除——它图形位置准但引脚变普通线条、丢电气连接。)
		zIndex = emitComponent(lines, inst, def, mapped.partId, mapped.uuid, mapped.deviceId, zIndex, sheet.wires);
	}

	return lines.join('\n');
}

// ─── Public helpers ──────────────────────────────────────────────────────────

/** 为一个符号生成对应的 DEVICE 文档源（嘉立创要求元件→符号→器件的完整链路）。 */
function generateTinyCadDeviceSource(def: TinyCadSymbolDef, deviceId: string, symbolUuid: string): string {
	const client = generateClient();
	const now = Date.now();
	const symName = def.name || def.description || def.refPrefix || 'Symbol';
	const refPrefix = def.refPrefix || 'U';
	const lines: string[] = [];
	lines.push(`{"type":"DOCHEAD"}||{"docType":"DEVICE","client":"${client}","uuid":"${deviceId}","updateTime":${now},"version":"${now}","editVersion":"3.2.175","user":{}}|`);
	lines.push(
		`{"type":"META","ticket":1,"id":"META"}||{"title":${JSON.stringify(symName)},"tags":[],"source":"${deviceId}|${symbolUuid}","images":[""],"attributes":{"Name":${JSON.stringify(symName)},"Designator":"${refPrefix}?","Add into BOM":"yes","Convert to PCB":"yes","Symbol":"${symbolUuid}","Footprint":""}}|`,
	);
	return lines.join('\n');
}

export interface TinyCadConversionResult {
	symbolSources: string[];
	deviceSources: string[];
	schematicPageSources: string[];
}

// ─── 电源符号识别(④)──────────────────────────────────────────────────────────
// 源文件里电源常以"符号实例"放置(GND/+5V 是 SYMBOL，不是 <POWER> 元素)，
// 需识别出来改走 docType:18 电源元件，否则当普通元件放会丢电源网络连通("+5V/GND 消失")。
function isPowerSymbolDef(def: TinyCadSymbolDef): boolean {
	const n = (def.name || '').toUpperCase();
	const r = (def.refPrefix || '').toUpperCase().replace(/\?/g, '');
	return /^(GND|VCC|VEE|AVCC|\+5V|\+3V3|\+12V|VBAT|VDD|VSS|CONTACT-POWER|POWER)/.test(n) || r === 'G' || r === 'V';
}
// 电源网络名：优先用实例 Name 字段(如 CONTACT-POWER 实例 Name='+5V')，否则回退 def.name(如 'GND')。
function instancePowerNetName(inst: TinyCadSymbolInstance, def: TinyCadSymbolDef): string {
	const nameField = inst.fields.find((f) => f.description === 'Name');
	const v = (nameField?.value || '').trim();
	if (v) return v;
	return def.name || 'POWER';
}

export function convertTinyCadSheetToProSources(sheet: TinyCadSheet): TinyCadConversionResult {
	const symbolSources: string[] = [];
	const deviceSources: string[] = [];
	const symbolPartMap = new Map<string, { uuid: string; partId: string; deviceId: string; def: TinyCadSymbolDef }>();

	const defById = new Map(sheet.symbolDefs.map((d) => [d.id, d]));
	// ★ 识别电源类 def(GND/VCC/+5V/CONTACT-POWER 等)，它们改走 docType:18 电源元件
	const powerDefIds = new Set<string>();
	for (const def of sheet.symbolDefs) {
		if (isPowerSymbolDef(def)) powerDefIds.add(def.id);
	}
	// 按 (符号定义, 缩放, 旋转, 镜像) 组合生成 SYMBOL——旋转/镜像烘焙进坐标，元件按 rotation=0 放置。
	// 这样引脚精确落在源导线端点上(电气连通)，不依赖嘉立创��旋转方向。
	const seen = new Set<string>();
	// 按 (符号定义, 缩放) 分组生成 SYMBOL——不烘焙旋转，引脚保持原位。
	// 旋转值直接设在 COMPONENT 的 rotation 字段，让嘉立创自己转。
	for (const inst of sheet.symbolInstances) {
		if (powerDefIds.has(inst.defId)) continue; // 电源类不走普通元件，下面 powerMap 处理
		const sx = inst.scaleX || 1; const sy = inst.scaleY || 1;
		const key = `${inst.defId}_${sx}_${sy}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const def = defById.get(inst.defId);
		if (!def) continue;
		const uuid = generateUUID();
		const deviceId = generateUUID();
		const { source, partId } = generateTinyCadSymbolSource(def, uuid, deviceId, sx, sy);
		symbolSources.push(source);
		deviceSources.push(generateTinyCadDeviceSource(def, deviceId, uuid));
		symbolPartMap.set(key, { uuid, partId, deviceId, def });
	}

	// 电源/接地符号：按网络名去重生成 docType:18 电源符号文档 + DEVICE
	const powerMap = new Map<string, { uuid: string; partId: string; deviceId: string }>();
	for (const pwr of sheet.powers || []) {
		const net = pwr.text || 'GND';
		if (powerMap.has(net)) continue;
		const puuid = generateUUID();
		const pdeviceId = generateUUID();
		const { source, partId } = generateTinyCadPowerSource(net, puuid, pdeviceId);
		symbolSources.push(source);
		deviceSources.push(generateTinyCadDeviceSource({ name: `Power-${net}`, refPrefix: '#', description: '' } as TinyCadSymbolDef, pdeviceId, puuid));
		powerMap.set(net, { uuid: puuid, partId, deviceId: pdeviceId });
	}

	// ★ 符号实例型电源(GND/+5V 等作为 SYMBOL 放置，非 <POWER> 元素)：按实例网络名去重生成
	for (const inst of sheet.symbolInstances) {
		if (!powerDefIds.has(inst.defId)) continue;
		const def = defById.get(inst.defId);
		if (!def) continue;
		const net = instancePowerNetName(inst, def);
		if (powerMap.has(net)) continue;
		const puuid = generateUUID();
		const pdeviceId = generateUUID();
		const { source, partId } = generateTinyCadPowerSource(net, puuid, pdeviceId);
		symbolSources.push(source);
		deviceSources.push(generateTinyCadDeviceSource({ name: `Power-${net}`, refPrefix: '#', description: '' } as TinyCadSymbolDef, pdeviceId, puuid));
		powerMap.set(net, { uuid: puuid, partId, deviceId: pdeviceId });
	}

	const schematicPageSources: string[] = [generateTinyCadSchematicPageSource(sheet, symbolPartMap, powerMap, powerDefIds, generateUUID())];

	return { symbolSources, deviceSources, schematicPageSources };
}
