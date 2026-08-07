/**
 * TinyCAD XML (.dsn) schematic parser.
 *
 * TinyCAD stores designs as XML with:
 *   - `<SYMBOLDEF>` symbol definitions containing shapes/pins
 *   - `<SYMBOL>` placements referencing symbol definitions
 *   - `<WIRE>`, `<BUS>`, `<JUNCTION>`, `<LABEL>` connectivity
 */

export interface TinyCadPoint {
	x: number;
	y: number;
}

export interface TinyCadPin {
	pos: TinyCadPoint;
	number: string;
	name: string;
	direction: number; // 0=down,1=up,2=right,3=left
	length: number;
	which: number;
	show: number;
}

export interface TinyCadField {
	description: string;
	value: string;
	show: string;
	pos: TinyCadPoint;
}

export type TinyCadShape =
	| { type: 'rectangle'; a: TinyCadPoint; b: TinyCadPoint; style: string; fill: string }
	| { type: 'polygon'; pos: TinyCadPoint; points: TinyCadPoint[]; style: string; fill: string }
	| { type: 'label'; pos: TinyCadPoint; text: string; direction: number; font: string; color: string; style: string };

export interface TinyCadSymbolDef {
	id: string;
	name: string;
	refPrefix: string;
	description: string;
	ppp: number;
	refPoint: TinyCadPoint;
	shapes: TinyCadShape[];
	pins: TinyCadPin[];
}

export interface TinyCadSymbolInstance {
	defId: string;
	pos: TinyCadPoint;
	rotation: number;
	scaleX: number;
	scaleY: number;
	fields: TinyCadField[];
}

export interface TinyCadWire {
	a: TinyCadPoint;
	b: TinyCadPoint;
}

export interface TinyCadBus {
	a: TinyCadPoint;
	b: TinyCadPoint;
}

export interface TinyCadJunction {
	pos: TinyCadPoint;
}

export interface TinyCadNetLabel {
	pos: TinyCadPoint;
	text: string;
	direction: number;
}

export interface TinyCadPower {
	pos: TinyCadPoint;
	text: string;
	direction: number;
	which: number;
}

export interface TinyCadText {
	pos: TinyCadPoint;
	text: string;
	direction: number;
	color: string;
}

export interface TinyCadSheet {
	name: string;
	width: number;
	height: number;
	symbolDefs: TinyCadSymbolDef[];
	symbolInstances: TinyCadSymbolInstance[];
	wires: TinyCadWire[];
	buses: TinyCadBus[];
	junctions: TinyCadJunction[];
	netLabels: TinyCadNetLabel[];
	powers: TinyCadPower[];
	texts: TinyCadText[];
	noconnects: TinyCadPoint[];
}

function parsePoint(raw: string): TinyCadPoint {
	const [x, y] = raw.split(',').map((v) => parseFloat(v.trim()));
	return { x: isNaN(x) ? 0 : x, y: isNaN(y) ? 0 : y };
}

function childText(el: Element, tag: string): string {
	const child = el.querySelector(tag);
	return child?.textContent?.trim() ?? '';
}

function attrNumber(el: Element, name: string, fallback = 0): number {
	const v = parseFloat(el.getAttribute(name) ?? '');
	return isNaN(v) ? fallback : v;
}

function attrString(el: Element, name: string, fallback = ''): string {
	return el.getAttribute(name) ?? fallback;
}

function parseSymbolDef(el: Element): TinyCadSymbolDef {
	const shapes: TinyCadShape[] = [];
	const pins: TinyCadPin[] = [];

	const innerTinyCad = el.querySelector(':scope > TinyCAD');
	if (innerTinyCad) {
		for (const child of Array.from(innerTinyCad.children)) {
			const tag = child.tagName.toUpperCase();
			if (tag === 'RECTANGLE') {
				shapes.push({
					type: 'rectangle',
					a: parsePoint(attrString(child, 'a', '0,0')),
					b: parsePoint(attrString(child, 'b', '0,0')),
					style: attrString(child, 'style', '0'),
					fill: attrString(child, 'fill', '0'),
				});
			} else if (tag === 'POLYGON') {
				const pos = parsePoint(attrString(child, 'pos', '0,0'));
				const points: TinyCadPoint[] = [];
				for (const pt of Array.from(child.querySelectorAll('POINT'))) {
					points.push(parsePoint(attrString(pt, 'pos', '0,0')));
				}
				shapes.push({
					type: 'polygon',
					pos,
					points,
					style: attrString(child, 'style', '0'),
					fill: attrString(child, 'fill', '0'),
				});
			} else if (tag === 'NOTE_TEXT') {
				// NOTE_TEXT: 符号内的引脚名标签(如 NLAS4501 的 COM/NO/GND/VCC)，属性 a="x,y" 是起点。
				// 此前未解析，导致芯片引脚名丢失。作为 label 形状输出。
				shapes.push({
					type: 'label',
					pos: parsePoint(attrString(child, 'a', '0,0')),
					text: child.textContent?.trim() ?? '',
					direction: attrNumber(child, 'direction', 0),
					font: attrString(child, 'font', '0'),
					color: attrString(child, 'color', '000000'),
					style: attrString(child, 'style', '0'),
				});
			} else if (tag === 'LABEL') {
				shapes.push({
					type: 'label',
					pos: parsePoint(attrString(child, 'pos', '0,0')),
					text: child.textContent?.trim() ?? '',
					direction: attrNumber(child, 'direction', 0),
					font: attrString(child, 'font', '0'),
					color: attrString(child, 'color', '000000'),
					style: attrString(child, 'style', '0'),
				});
			} else if (tag === 'PIN') {
				pins.push({
					pos: parsePoint(attrString(child, 'pos', '0,0')),
					number: attrString(child, 'number', ''),
					name: child.textContent?.trim() ?? '',
					direction: attrNumber(child, 'direction', 0),
					length: attrNumber(child, 'length', 10),
					which: attrNumber(child, 'which', 0),
					show: attrNumber(child, 'show', 0),
				});
			}
		}
	}

	// REF_POINT: 符号的参考原点。SYMBOL 文档内所有坐标必须减去此值（相对原点存储）。
	const refPointEl = el.querySelector(':scope > REF_POINT') || innerTinyCad?.querySelector('REF_POINT');
	const refPoint = refPointEl ? parsePoint(attrString(refPointEl, 'pos', '0,0')) : { x: 0, y: 0 };

	return {
		id: attrString(el, 'id', ''),
		name: childText(el, 'NAME'),
		refPrefix: childText(el, 'REF'),
		description: childText(el, 'DESCRIPTION'),
		ppp: parseInt(childText(el, 'PPP') || '1', 10) || 1,
		refPoint,
		shapes,
		pins,
	};
}

function parseSymbolInstance(el: Element): TinyCadSymbolInstance {
	const fields: TinyCadField[] = [];
	for (const field of Array.from(el.querySelectorAll(':scope > FIELD'))) {
		// TinyCAD 的 FIELD 有两种写法：属性形式 <FIELD description="Ref" value="U1"/>
		// （实际 .dsn 样本采用）与子元素形式 <FIELD><DESCRIPTION>..</DESCRIPTION>..</FIELD>
		// （格式文档示例）。优先读属性，缺失时再回退到子元素，兼容两种。
		fields.push({
			description: attrString(field, 'description', '') || childText(field, 'DESCRIPTION'),
			value: attrString(field, 'value', '') || childText(field, 'VALUE'),
			show: attrString(field, 'show', '0'),
			pos: parsePoint(attrString(field, 'pos', '0,0')),
		});
	}
	return {
		defId: attrString(el, 'id', ''),
		pos: parsePoint(attrString(el, 'pos', '0,0')),
		rotation: attrNumber(el, 'rotate', 0),
		scaleX: attrNumber(el, 'scale_x', 1),
		scaleY: attrNumber(el, 'scale_y', 1),
		fields,
	};
}

export function parseTinyCadDsn(xmlText: string): TinyCadSheet {
	const parser = new DOMParser();
	const doc = parser.parseFromString(xmlText, 'application/xml');
	const parserError = doc.querySelector('parsererror');
	if (parserError) {
		throw new Error('TinyCAD XML parse error: ' + parserError.textContent);
	}

	// 兼容两种根结构（实测用户真实文件即第二种）：
	//   ① 标准：<TinyCADSheets><TinyCAD>...</TinyCAD></TinyCADSheets>
	//   ② 裸根：<TinyCAD>...</TinyCAD>（无 TinyCADSheets 包裹，部分 TinyCAD 导出变体/清洗脚本会产生）
	// 此前只认 ①，遇到 ② 直接抛错，导致导线/元件图形在解析第一步就全丢。
	let root = doc.querySelector('TinyCADSheets > TinyCAD');
	if (!root) {
		root = doc.querySelector('TinyCAD');
	}
	if (!root) {
		throw new Error('TinyCAD: missing <TinyCAD> root element');
	}

	const sheetName = childText(root, 'NAME') || 'Sheet 1';
	const details = root.querySelector('DETAILS');
	const sizeEl = details?.querySelector('Size');
	const width = parseFloat(sizeEl?.getAttribute('width') ?? '1485');
	const height = parseFloat(sizeEl?.getAttribute('height') ?? '1050');

	const symbolDefs: TinyCadSymbolDef[] = [];
	for (const def of Array.from(root.querySelectorAll(':scope > SYMBOLDEF'))) {
		symbolDefs.push(parseSymbolDef(def));
	}

	const symbolInstances: TinyCadSymbolInstance[] = [];
	for (const sym of Array.from(root.querySelectorAll(':scope > SYMBOL'))) {
		symbolInstances.push(parseSymbolInstance(sym));
	}

	const wires: TinyCadWire[] = [];
	for (const wire of Array.from(root.querySelectorAll(':scope > WIRE'))) {
		wires.push({
			a: parsePoint(attrString(wire, 'a', '0,0')),
			b: parsePoint(attrString(wire, 'b', '0,0')),
		});
	}

	const buses: TinyCadBus[] = [];
	for (const bus of Array.from(root.querySelectorAll(':scope > BUS'))) {
		buses.push({
			a: parsePoint(attrString(bus, 'a', '0,0')),
			b: parsePoint(attrString(bus, 'b', '0,0')),
		});
	}

	const junctions: TinyCadJunction[] = [];
	for (const junc of Array.from(root.querySelectorAll(':scope > JUNCTION'))) {
		junctions.push({
			pos: parsePoint(attrString(junc, 'pos', '0,0')),
		});
	}

	const netLabels: TinyCadNetLabel[] = [];
	for (const label of Array.from(root.querySelectorAll(':scope > LABEL'))) {
		netLabels.push({
			pos: parsePoint(attrString(label, 'pos', '0,0')),
			text: label.textContent?.trim() ?? '',
			direction: attrNumber(label, 'direction', 0),
		});
	}

	// 电源符号: <POWER pos="42,200" which="0" direction="1">GND</POWER>
	const powers: TinyCadPower[] = [];
	for (const pwr of Array.from(root.querySelectorAll(':scope > POWER'))) {
		powers.push({
			pos: parsePoint(attrString(pwr, 'pos', '0,0')),
			text: pwr.textContent?.trim().split('<')[0] ?? '',
			direction: attrNumber(pwr, 'direction', 0),
			which: attrNumber(pwr, 'which', 0),
		});
	}

	// 文字标注: <TEXT pos="100,200" direction="0" color="000000">文字内容</TEXT>
	const texts: TinyCadText[] = [];
	for (const txt of Array.from(root.querySelectorAll(':scope > TEXT'))) {
		texts.push({
			pos: parsePoint(attrString(txt, 'pos', '0,0')),
			text: txt.textContent?.trim() ?? '',
			direction: attrNumber(txt, 'direction', 0),
			color: attrString(txt, 'color', '000000'),
		});
	}

	// 不连接标记: <NOCONNECT pos="100,200"/>
	const noconnects: TinyCadPoint[] = [];
	for (const nc of Array.from(root.querySelectorAll(':scope > NOCONNECT'))) {
		noconnects.push(parsePoint(attrString(nc, 'pos', '0,0')));
	}

	return {
		name: sheetName,
		width,
		height,
		symbolDefs,
		symbolInstances,
		wires,
		buses,
		junctions,
		netLabels,
		powers,
		texts,
		noconnects,
	};
}
