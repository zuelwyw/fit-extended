/**
 * Git 对象格式同口径摘要（诊断修复 D1/D2 的核心）
 *
 * 目的：消除默认检查对"两端同名文件"逐文件拉取远端 blob 的开销。
 *
 * 原理：远端快照里每条路径已经带有 **Git blob SHA**（不可变对象标识，同一提交内
 * 永不变）。Git blob SHA = SHA1("blob " + 字节数 + \0 + 原始字节)。本地只需对实际
 * 字节按同一对象格式计算一次，就能在不发起任何网络请求的前提下判断"本地内容
 * 是否就是远端 blob"——这不是比较两套算法的 SHA（旧 localSha vs blob SHA），
 * 而是把本地字节**换算成远端对象的口径**再比较，比较对象是同一算法的输出。
 *
 * 边界（不可妥协）：
 * - 只在**未加密**时可用：加密用户的远端 blob 是密文，明文字节的对象 hash 必然
 *   不等，比较结果恒 false——此时必须走原逐文件比较（甚至更保守：直接跳过快速
 *   路径），绝不拿明文 hash 冒充密文 blob。
 * - 结果只作为"内容相同"的证据（可记共同状态），**不作为"不同"的证据**去自动
 *   覆盖：hash 不等仍回退到逐文件摘要比较/冲突流程，保持六模式与删除安全语义。
 * - 不新增依赖、不用 Node crypto，WebCrypto SHA-1 移动端可用。
 */

import { BlobSha } from "./hashing";
import { ContentDigest } from "./contentDigest";
import { FileContent } from "./contentEncoding";
import { contentToArrayBuffer } from "./obsidianHelpers";

/** 对原始字节按 Git blob 对象格式计算 SHA-1（"blob <len>\0<bytes>"）。 */
export async function gitBlobHash(bytes: ArrayBuffer): Promise<BlobSha> {
	const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
	const payload = new Uint8Array(bytes);
	const combined = new Uint8Array(header.length + payload.length);
	combined.set(header, 0);
	combined.set(payload, header.length);
	const hash = await crypto.subtle.digest("SHA-1", combined.buffer as ArrayBuffer);
	let hex = "";
	for (const b of new Uint8Array(hash)) hex += b.toString(16).padStart(2, "0");
	return hex as BlobSha;
}

/**
 * 本地内容是否就是远端 blob（未加密快速路径）。
 *
 * @param expectedBlobSha 远端快照给出的不可变 blob OID
 * @returns true=本地字节与远端 blob 完全一致（可作"内容相同"证据）；
 *          false=不一致或口径不可用（调用方回退逐文件比较，不得据此判定"不同"）
 */
export async function localBytesMatchGitBlob(content: FileContent, expectedBlobSha: BlobSha): Promise<boolean> {
	// base64 归一后取原始字节：与远端 blob 的字节口径一致（含空文件、二进制）。
	const base64 = content.toBase64();
	const bytes = contentToArrayBuffer(base64);
	const actual = await gitBlobHash(bytes);
	return actual === expectedBlobSha;
}

/**
 * ContentDigest 与 Git blob OID 的绑定记录（D2 共同状态持久化用）。
 *
 * 保存的是"该 digest 已被证实对应远端该 blob OID"的绑定，供下次检查跳过
 * 内容 GET：先看快照 OID 是否仍是该 OID（不可变，未变则无需重拉），
 * 再决定是否需要逐文件比较。
 */
export type BlobDigestBinding = {
	digest: ContentDigest;
	blobSha: BlobSha;
};

export function toBlobDigestBinding(digest: ContentDigest, blobSha: BlobSha): BlobDigestBinding {
	return { digest, blobSha };
}
