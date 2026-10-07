import { describe, expect, it } from "vitest";
import {
  decodeQqAcData,
  evaluateNonceAssignment,
  evaluateNonceExpression,
  extractQqAcChapterList,
  extractQqAcNonce,
  extractQqAcPageData,
  isQqAcHost,
  mobileQqAcUrl,
  parseQqAcChapterUrl,
} from "./qqAcPage";

describe("parseQqAcChapterUrl", () => {
  it("parses the mobile chapter link", () => {
    expect(parseQqAcChapterUrl("https://m.ac.qq.com/chapter/index/id/655964/cid/62284")).toEqual({
      comicId: "655964",
      chapterId: "62284",
    });
  });

  it("parses the desktop ChapterView link", () => {
    expect(parseQqAcChapterUrl("https://ac.qq.com/ChapterView/index/id/655964/cid/62284")).toEqual({
      comicId: "655964",
      chapterId: "62284",
    });
  });

  it("rejects foreign hosts and non-chapter paths", () => {
    expect(parseQqAcChapterUrl("https://m.ac.qq.com/comic/index/id/655964")).toBeNull();
    expect(parseQqAcChapterUrl("https://example.com/chapter/index/id/1/cid/2")).toBeNull();
    expect(parseQqAcChapterUrl("not a url")).toBeNull();
  });

  it("recognizes both hosts", () => {
    expect(isQqAcHost("m.ac.qq.com")).toBe(true);
    expect(isQqAcHost("ac.qq.com")).toBe(true);
    expect(isQqAcHost("www.ac.qq.com")).toBe(true);
    expect(isQqAcHost("example.com")).toBe(false);
  });

  it("builds the mobile url used for scraping", () => {
    expect(mobileQqAcUrl("655964", "62284")).toBe("https://m.ac.qq.com/chapter/index/id/655964/cid/62284");
  });
});

describe("evaluateNonceExpression", () => {
  it("evaluates arithmetic expressions", () => {
    expect(evaluateNonceExpression("4 * 1 / 4")).toBe(1);
    expect(evaluateNonceExpression("(2 + 3) * 2")).toBe(10);
  });

  it("evaluates JS truthy chains like the site generates", () => {
    expect(evaluateNonceExpression("!!1+!1+!!2+!!2+1")).toBe(4);
    expect(evaluateNonceExpression("4 + !!!1")).toBe(4);
  });

  it("evaluates parseInt and charCodeAt", () => {
    expect(evaluateNonceExpression("parseInt(7/3)")).toBe(2);
    expect(evaluateNonceExpression("'1'.charCodeAt() - 45")).toBe(4);
  });

  it("evaluates Math helpers and double bitwise NOT", () => {
    expect(evaluateNonceExpression("Math.round(.5) + ~~1.0")).toBe(2);
    expect(evaluateNonceExpression("Math.floor(9/4)")).toBe(2);
  });

  it("returns null for anything outside the tiny safe grammar", () => {
    expect(evaluateNonceExpression("require('fs')")).toBeNull();
    expect(evaluateNonceExpression("process.exit(1)")).toBeNull();
    expect(evaluateNonceExpression("constructor")).toBeNull();
  });
});

describe("evaluateNonceAssignment", () => {
  it("builds the nonce from the obfuscated assignment (variant 1)", () => {
    const expression =
      '"a829b3ba" + (+eval("\'1\'.charCodeAt() - 45")).toString() + "9e6fadedfad03ec1114bfda"';
    expect(evaluateNonceAssignment(expression)).toBe("a829b3ba49e6fadedfad03ec1114bfda");
  });

  it("builds the nonce when eval strings contain plus signs (variant 2)", () => {
    const expression =
      '"596a" + (+eval("4 * 1 / 4")).toString() + "97697e4215d9" + (+eval("!!1+!1+!!2+!!2+1")).toString() + "14606" + (+eval("!!1")).toString() + "98fcc14" + (+eval("parseInt(7/3)")).toString() + ""';
    expect(evaluateNonceAssignment(expression)).toBe("596a197697e4215d9414606198fcc142");
  });

  it("builds the nonce with Math and bang chains (variant 3)", () => {
    const expression =
      '"d4295fe8a24a2" + (+eval("4 + !!!1")).toString() + "e2e65857" + (+eval("Math.round(.5) + ~~1.0")).toString() + "c1299d1fc"';
    expect(evaluateNonceAssignment(expression)).toBe("d4295fe8a24a24e2e658572c1299d1fc");
  });

  it("rejects unknown shapes", () => {
    expect(evaluateNonceAssignment("window.location")).toBeNull();
    expect(evaluateNonceAssignment('eval("evil()") + "12345678"')).toBeNull();
  });
});

describe("extractQqAcNonce", () => {
  it("handles the n+once key split", () => {
    const html = `<script>window["n"+"once"] = "a829b3ba" + (+eval("'1'.charCodeAt() - 45")).toString() + "9e6fadedfad03ec1114bfda"</script>`;
    expect(extractQqAcNonce(html)).toBe("a829b3ba49e6fadedfad03ec1114bfda");
  });

  it("handles the no+nce key split", () => {
    const html = `<script>window["no"+"nce"] = "d4295fe8a24a2" + (+eval("4 + !!!1")).toString() + "e2e65857" + (+eval("Math.round(.5) + ~~1.0")).toString() + "c1299d1fc"</script>`;
    expect(extractQqAcNonce(html)).toBe("d4295fe8a24a24e2e658572c1299d1fc");
  });

  it("ignores other window assignments", () => {
    const html = `<script>window["x"+"yz"] = "a829b3ba9e6fadedfad03ec1114bfda"</script>`;
    expect(extractQqAcNonce(html)).toBeNull();
  });
});

describe("decodeQqAcData", () => {
  const payload = {
    comic: { id: 655964, title: "从水猴子开始成神" },
    chapter: { cid: 62284, title: "预告", canRead: true },
    picture: [{ pid: "1", url: "https://manhua.acimg.cn/x.png/800" }],
  };

  function obfuscate(base64: string, nonce: string): string {
    // نماثل المُشفِّر: أقحم الشوائب بترتيب مفاتيح nonce — الفك يقيسها بالعكس
    const tokens = nonce.match(/\d+[a-zA-Z]+/g) ?? [];
    let result = base64;
    for (const token of tokens) {
      const match = token.match(/^(\d+)([a-zA-Z]+)$/);
      if (!match) continue;
      const position = Number.parseInt(match[1]!, 10) & 255;
      result = result.slice(0, position) + match[2] + result.slice(position);
    }
    return result;
  }

  it("recovers the JSON after removing the injected junk", () => {
    const base64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    const nonce = "3ab12cd20ef";
    const scrambled = obfuscate(base64, nonce);
    // الشوائب واقعة فعلًا داخل السرب
    expect(scrambled).not.toBe(base64);
    expect(decodeQqAcData(scrambled, nonce)).toEqual(payload);
  });

  it("returns null when the nonce does not match the payload", () => {
    const base64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    const scrambled = obfuscate(base64, "3ab12cd20ef");
    expect(decodeQqAcData(scrambled, "9zz8yy7xx")).toBeNull();
    expect(decodeQqAcData("", "3ab12cd20ef")).toBeNull();
  });
});

describe("page data extraction", () => {
  it("finds the embedded data payload", () => {
    const html = `var pg = new BIU.Page({ name: 'pg_ChapterIndex', data: 'eyJjb21pYyI6eyJpZCI6NjU1OTY0LCJ0aXRsZSI6Ilx1NGVjZSJ9fQ==', chapterInfo: [] });`;
    expect(extractQqAcPageData(html)).toBe("eyJjb21pYyI6eyJpZCI6NjU1OTY0LCJ0aXRsZSI6Ilx1NGVjZSJ9fQ==");
  });

  it("finds the chapter index block", () => {
    const html = `<script id="data_chapterInfo">[{"cid":62284,"seq_no":1,"title":"预告","url":"/chapter/index/id/655964/cid/62284","vipStatus":1},{"cid":81946,"seq_no":2,"title":"01.难活","url":"/chapter/index/id/655964/cid/81946","vipStatus":1}]</script>`;
    const list = extractQqAcChapterList(html);
    expect(list).toHaveLength(2);
    expect(list?.[0]).toMatchObject({ cid: 62284, seqNo: 1, title: "预告", vipState: 1 });
    expect(list?.[1]?.title).toBe("01.难活");
  });
});
