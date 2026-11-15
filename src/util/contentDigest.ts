/**
 * 内容摘要（同一口径，可跨端比较）
 *
 * 为什么需要它：本地 SHA 是 SHA1(路径 + 文本/base64)，远端是 Git blob SHA，
 * 两者算法不同，任何跨端比较都无效。判断"两边内容是否一致""相对共同状态是否改动"
 * 必须用同一口径的摘要——本模块对**解密后的原始字节**做 SHA1。
 *
 * 平台约束：只用 Web Crypto 与 Obsidian 的 base64 转换，不依赖 Node 内置模块，
 * 移动端可用。
 */

import { FileContent } from "./contentEncoding";
import { contentToArrayBuffer } from "./obsidianHelpers";

export type ContentDigest = string & { readonly __brand: "ContentDigest" };

const DIGEST_PREFIX = "sha1:";

export function isContentDigest(value: unknown): value is ContentDigest {
	return typeof value === "string" && value.startsWith(DIGEST_PREFIX);
}

function toHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let hex = "";
	for (let i = 0; i < bytes.length; i++) {
		hex += bytes[i].toString(16).padStart(2, "0");
	}
	return hex;
}

/** 对原始字节计算摘要（与内容来自本地还是远端无关）。 */
export async function digestBytes(buffer: ArrayBuffer): Promise<ContentDigest> {
	const hash = await crypto.subtle.digest("SHA-1", buffer);
	return `${DIGEST_PREFIX}${toHex(hash)}` as ContentDigest;
}

/**
 * 对 FileContent 计算摘要。
 *
 * FileContent 可能携带 plaintext 或 base64 编码；两种形式都会先归一成字节再摘要，
 * 因此同一个文件经不同读取路径（本地明文 / GitHub base64）得到的摘要相同。
 */
export async function digestFileContent(content: FileContent): Promise<ContentDigest> {
	const base64 = content.toBase64();
	// 空文件也必须得到稳定摘要：contentToArrayBuffer("") 返回长度为 0 的 buffer。
	return digestBytes(contentToArrayBuffer(base64));
}

/** 对文本按 UTF-8 字节计算摘要（测试与纯逻辑共用，避免各处重写 TextEncoder 样板）。 */
export async function contentDigestOfText(text: string): Promise<ContentDigest> {
	const bytes = new TextEncoder().encode(text);
	const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
	return digestBytes(buffer);
}
