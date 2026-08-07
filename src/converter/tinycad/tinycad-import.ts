/**
 * TinyCAD XML schematic → EasyEDA Pro project archive importer.
 */
import JSZip from 'jszip';

import { diag } from '../diag';
import { buildEpro2Archive } from '../easyeda-pro/epro2-builder';
import type { ConverterImporter, ImportResult } from '../types';
import { parseTinyCadDsn } from './tinycad-parser';
import { convertTinyCadSheetToProSources } from './tinycad-pro-adapter';

function looksLikeTinyCad(content: string): boolean {
	// 识别 TinyCAD 文件：只要有 <TinyCADSheets> 或 <TinyCAD> 标签即可。
	// 不要求 <?xml 声明——老版本 TinyCAD(如 1.95.27)导出的 .dsn 没有 <?xml，
	// 直接以注释 + <TinyCADSheets> 开头，此前要求 <?xml 会把这些文件误判为"非 TinyCAD"拒绝导入。
	const lower = content.toLowerCase();
	return lower.includes('<tinycadsheets>') || lower.includes('<tinycad>');
}

async function readInput(input: File | Blob | ArrayBuffer): Promise<ArrayBuffer> {
	if (typeof Blob !== 'undefined' && input instanceof Blob && typeof (input as Blob).arrayBuffer === 'function') {
		return await (input as Blob).arrayBuffer();
	}
	return input as ArrayBuffer;
}

export async function importTinyCad(
	input: File | Blob | ArrayBuffer,
	onProgress?: (done: number, total: number, name: string) => void,
): Promise<ImportResult> {
	if (onProgress) onProgress(0, 1, 'TinyCAD');

	const buffer = await readInput(input);
	let content = '';

	const asText = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
	if (looksLikeTinyCad(asText)) {
		content = asText;
	} else {
		const zip = await JSZip.loadAsync(buffer);
		const candidates: string[] = [];
		zip.forEach((path) => {
			if (path.toLowerCase().endsWith('.dsn')) candidates.push(path);
		});
		for (const path of candidates) {
			const entry = zip.file(path);
			if (!entry) continue;
			const candidate = await entry.async('string');
			if (looksLikeTinyCad(candidate)) {
				content = candidate;
				break;
			}
		}
	}

	if (!content) {
		return {
			devices: [{ name: 'TinyCAD', status: 'fail', message: '未识别到 TinyCAD 文件' }],
			footprints: [],
			symbols: [],
			blob: new Blob(),
		};
	}

	const sheet = parseTinyCadDsn(content);
	// ★ parse 阶段埋点：记录【插件实际】读到的 WIRE/元件/电源数量与前几条坐标。
	// 对比源文件，即可判断解析有没有漏读 WIRE(用户怀疑连线没被解析)。
	diag.reset();
	diag.push('===== parse 阶段(插件实际读取) =====');
	diag.push(`[eext 版本] v1.7.3`);
	diag.push(
		`[解析结果] 符号定义=${sheet.symbolDefs.length} 元件实例=${sheet.symbolInstances.length} 导线WIRE=${sheet.wires.length} 电源POWER=${(sheet.powers || []).length} 网络标签=${sheet.netLabels.length}`,
	);
	diag.push(`[前8条 WIRE 坐标(源文件,经插件DOMParser解析)]`);
	sheet.wires.slice(0, 8).forEach((w, i) => diag.push(`  WIRE ${i + 1}: (${w.a.x},${w.a.y}) -> (${w.b.x},${w.b.y})`));
	diag.push(`[前6个元件位置]`);
	sheet.symbolInstances.slice(0, 6).forEach((inst, i) => {
		const ref = inst.fields.find((f) => f.description === 'Ref')?.value || '?';
		const refF = inst.fields.find((f) => f.description === 'Ref');
		diag.push(
			`  ${i + 1}. ${ref}: pos=(${inst.pos.x},${inst.pos.y}) rot=${inst.rotation} FIELD.pos=(${refF?.pos.x ?? '?'},${refF?.pos.y ?? '?'})`,
		);
	});
	const { symbolSources, deviceSources, schematicPageSources } = convertTinyCadSheetToProSources(sheet);
	// 工程名带版本标记：导入后看工程名即可确认插件是否真正更新(嘉立创常缓存旧插件)。
	// 若看到 "[v1.6.4]" 说明新插件在跑；若没有，说明还在跑旧版(需彻底重启嘉立创)。
	const projectName = `[v1.7.3] ${sheet.name || 'TinyCAD Import'}`;
	const epro2Blob = await buildEpro2Archive({
		projectName,
		schematicPageSources,
		symbolSources,
		deviceSources,
	});

	if (onProgress) onProgress(1, 1, projectName);

	return {
		devices: [],
		footprints: [],
		symbols: [],
		blob: epro2Blob,
		isProjectArchive: true,
	};
}

export const tinycadImport: ConverterImporter = {
	name: 'tinycad',
	displayName: 'Import TinyCAD files',
	supportedExtensions: ['.zip', '.dsn'],
	importArchive: importTinyCad,
};
