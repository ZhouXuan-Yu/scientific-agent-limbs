/**
 * test-write —— L1.1 验收：Zotero 本地 API 写入能力端到端测试。
 *
 * 安全边界：
 *   - 只创建一条带 limbs-write-test 标签的独立笔记，不碰任何既有条目
 *   - 不放进任何分类
 *   - 结束时（含异常路径）删除该条目
 *
 * 前置：Zotero 在运行。首次运行会在 Zotero 弹出授权框，**请选 Always Allow**，
 * 否则本地 key 为一次性，每写一次都要重新弹窗。
 *
 * 用法：node test-write.mjs
 */

import { health, serverId, cachedKey, authorize, write, api } from "./zotero-core.mjs";

const TEST_TAG = "limbs-write-test";
const lines = [];
let failed = 0;

function rec(step, ok, detail = "") {
  if (!ok) failed++;
  const line = `${ok ? "PASS" : "FAIL"}  ${step}${detail ? "  " + detail : ""}`;
  lines.push(line);
  process.stdout.write(line + "\n");
}

const stamp = new Date().toISOString();
let itemKey = null;
let lastVersion = null;

/* ---------------- 0. 前置 ---------------- */

const h = await health();
rec("zotero alive", h.ok, `v${h.version} topItems=${h.topItems} started=${h.started}`);
if (!h.ok) {
  process.stdout.write(`\nABORT: Zotero not reachable (${h.note || "unknown"})\n`);
  process.exitCode = 1;
} else {
  /* ---------------- 1. 授权 ---------------- */
  const sid = await serverId();
  rec("server-id", !!sid, String(sid));

  let key = cachedKey(sid);
  rec("cached write key", !!key, key ? "reused" : "none, authorize needed");

  if (!key) {
    process.stdout.write("AUTHORIZE: a confirmation dialog should appear in Zotero. Choose 'Always Allow'.\n");
    const a = await authorize({ appName: "Hana Agent (limbs L1.1)" });
    if (!a.ok) {
      rec("authorize", false, JSON.stringify(a));
    } else {
      rec("authorize", true, `remember=${a.remember} cached=${a.cached}`);
      key = a.key;
    }
  }

  if (!key) {
    process.stdout.write("\nABORT: no write key, cannot continue.\n");
    process.exitCode = 1;
  } else {
    try {
      /* ---------------- 2. 创建测试条目 ---------------- */
      const create = await write("/api/users/0/items", {
        method: "POST",
        authKey: key,
        body: [
          {
            itemType: "note",
            note: `<p>limbs write test ${stamp}. Automatically created, safe to delete.</p>`,
            tags: [{ tag: TEST_TAG }],
          },
        ],
      });
      if (create.needsAuth) {
        rec("create item", false, "401 unauthorized (key invalid or already consumed)");
      } else {
        const s = create.json?.successful?.["0"];
        itemKey = s?.key || null;
        lastVersion = s?.version ?? null;
        rec("create item", create.ok && !!itemKey, `status=${create.status} key=${itemKey}`);
      }

      /* ---------------- 3. 读回 ---------------- */
      if (itemKey) {
        const read = await api(`/api/users/0/items/${itemKey}`);
        const d = read.json?.data;
        rec(
          "read back",
          read.ok && d?.itemType === "note",
          `status=${read.status} tags=${JSON.stringify((d?.tags || []).map((t) => t.tag))}`,
        );
        lastVersion = read.json?.version ?? lastVersion;
      }

      /* ---------------- 4. 改标签（PATCH） ---------------- */
      if (itemKey) {
        const patch = await write(`/api/users/0/items/${itemKey}`, {
          method: "PATCH",
          authKey: key,
          version: lastVersion,
          body: { tags: [{ tag: TEST_TAG }, { tag: `${TEST_TAG}-b` }] },
        });
        // 本地 API 的 PATCH 成功返回 204 No Content，没有响应体，不能靠 json.successful 判定
        const s = patch.json?.successful?.["0"];
        if (s?.version) lastVersion = s.version;
        else if (patch.libraryVersion) lastVersion = patch.libraryVersion;
        rec(
          "patch tags",
          patch.ok && (patch.status === 204 || patch.status === 200),
          `status=${patch.status} libraryVersion=${lastVersion}`,
        );
      }

      /* ---------------- 5. 验证标签 ---------------- */
      if (itemKey) {
        const read2 = await api(`/api/users/0/items/${itemKey}`);
        const tags = (read2.json?.data?.tags || []).map((t) => t.tag);
        rec(
          "verify tags",
          tags.includes(TEST_TAG) && tags.includes(`${TEST_TAG}-b`),
          JSON.stringify(tags),
        );
        lastVersion = read2.json?.version ?? read2.headers.get("last-modified-version") ?? lastVersion;
      }

      /* ---------------- 6. 附件能力探测（只探测，不上传文件） ---------------- */
      if (itemKey) {
        const probe = await write(`/api/users/0/items/${itemKey}/file`, {
          method: "POST",
          authKey: key,
          version: lastVersion,
          body: { md5: "00000000000000000000000000000000", filename: "probe.txt", filesize: 1, mtime: Date.now() },
        });
        // 期望：拿到 uploadKey 或明确拒绝（非 401 即说明写通道已通）
        rec(
          "file upload channel",
          probe.status !== 401,
          `status=${probe.status} ${probe.status === 400 ? "(rejected payload, channel alive)" : ""}`.trim(),
        );
      }
    } finally {
      /* ---------------- 7. 清理 ---------------- */
      if (itemKey) {
        const del = await write(`/api/users/0/items/${itemKey}`, {
          method: "DELETE",
          authKey: key,
          version: lastVersion,
        });
        rec("delete test item", del.ok || del.status === 404, `status=${del.status}`);
        const check = await api(`/api/users/0/items/${itemKey}`);
        rec("verify deletion", check.status === 404, `status=${check.status}`);
        if (check.status !== 404) {
          process.stdout.write(`\nRESIDUAL ITEM: ${itemKey} still exists, delete it in Zotero manually.\n`);
        }
      }
    }
  }
}

process.stdout.write(`\n${failed === 0 ? "RESULT: ALL PASS" : `RESULT: ${failed} FAILED`}\n`);
process.exitCode = failed === 0 ? 0 : 1;
