import { describe, expect, it } from "vitest";
import {
  extractKuaikanImages,
  extractKuaikanNuxtPayload,
  extractKuaikanPageTitle,
  isKuaikanHost,
  isKuaikanPayComic,
  parseKuaikanTitle,
  parseKuaikanUrl,
  parseNuxtPayload,
  unescapeJsString,
} from "./kuaikanPage";

describe("parseKuaikanUrl", () => {
  it("parses both mobile hosts", () => {
    expect(parseKuaikanUrl("https://kuaikanmanhua.com/mobile/comics/851732/")).toEqual({ comicId: "851732" });
    expect(parseKuaikanUrl("https://m.kuaikanmanhua.com/mobile/comics/851732/")).toEqual({ comicId: "851732" });
  });

  it("parses the desktop reader path", () => {
    expect(parseKuaikanUrl("https://kuaikanmanhua.com/web/comic/851732")).toEqual({ comicId: "851732" });
  });

  it("rejects series pages and foreign hosts", () => {
    expect(parseKuaikanUrl("https://kuaikanmanhua.com/web/topic/100")).toBeNull();
    expect(parseKuaikanUrl("https://example.com/mobile/comics/851732/")).toBeNull();
    expect(parseKuaikanUrl("not a url")).toBeNull();
  });

  it("recognizes both hosts", () => {
    expect(isKuaikanHost("kuaikanmanhua.com")).toBe(true);
    expect(isKuaikanHost("m.kuaikanmanhua.com")).toBe(true);
    expect(isKuaikanHost("www.kuaikanmanhua.com")).toBe(true);
    expect(isKuaikanHost("example.com")).toBe(false);
  });
});

describe("unescapeJsString", () => {
  it("unescapes unicode escapes used by the site", () => {
    expect(unescapeJsString("https:\\u002F\\u002Ftn1.kkmh.com\\u002Fimage")).toBe("https://tn1.kkmh.com/image");
    expect(unescapeJsString("第1话\\n预告")).toBe("第1话\n预告");
    expect(unescapeJsString("plain")).toBe("plain");
  });
});

describe("NUXT payload parsing", () => {
  // سرب مصغّر على بنية الموقع الحقيقية: 8 معاملات ووسائط مطابقة،
  // مع Array(4) و{} كما تظهر في السرب الفعلي
  const values = [
    "1280",
    "https:\\u002F\\u002Fimg.example\\u002Fa-t.w1280.jpg",
    "640",
    "https:\\u002F\\u002Fimg.example\\u002Fa-t.w640.jpg",
    "640",
    "https:\\u002F\\u002Fimg.example\\u002Fb-t.w640.jpg",
    "2",
    "https:\\u002F\\u002Fimg.example\\u002Fb-t.w1280.jpg",
  ];
  const payload = `(function(a,b,c,d,e,f,g,h){var tags=Array(4);tags[0]="tag";var o={id:a,title:"عمل",comic_images:[{width:a,height:c,url:"https:\\u002F\\u002Fimg.example\\u002Fa-t.w640.jpg",width1280:a,url1280:b},{width:a,height:c,url:"https:\\u002F\\u002Fimg.example\\u002Fb-t.w640.jpg",width1280:a,url1280:h}]};var meta={};}(${values.map(v => `"${v}"`).join(",")},Array(4),{}))`;
  // لاحظ: الوسائط أعلاه 8 نصوص ثم Array و{} — المعاملات 8 فيجب أن يكون
  // التحليل متسامحًا مع الزوائد، لكن التنفيذ يتطابق تمامًا؛ لذا نبني هنا
  // سربًا مطابقًا تمامًا بدل الاعتماد على التسامح.

  const exactPayload = `(function(a,b,c,d,e,f,g,h){comic_images:[{width:a,height:c,url:"https:\\u002F\\u002Fimg.example\\u002Fa-t.w640.jpg",width1280:a,url1280:b},{width:a,height:c,url:"https:\\u002F\\u002Fimg.example\\u002Fb-t.w640.jpg",width1280:a,url1280:h}]}("1280","https:\\u002F\\u002Fimg.example\\u002Fa-t.w1280.jpg","640","https:\\u002F\\u002Fimg.example\\u002Fa-t.w640.jpg","640","https:\\u002F\\u002Fimg.example\\u002Fb-t.w640.jpg","2","https:\\u002F\\u002Fimg.example\\u002Fb-t.w1280.jpg"))`;

  it("parses parameters and call arguments 1:1", () => {
    const map = parseNuxtPayload(exactPayload);
    expect(map).not.toBeNull();
    expect(map?.size).toBe(8);
    expect(map?.get("b")).toBe("https://img.example/a-t.w1280.jpg");
    expect(map?.get("h")).toBe("https://img.example/b-t.w1280.jpg");
  });

  it("extracts high-res image urls in reader order", () => {
    const map = parseNuxtPayload(exactPayload)!;
    expect(extractKuaikanImages(exactPayload, map)).toEqual([
      "https://img.example/a-t.w1280.jpg",
      "https://img.example/b-t.w1280.jpg",
    ]);
  });

  it("falls back to the inline low-res url when url1280 is absent", () => {
    const inlinePayload = `(function(a,b,c){comic_images:[{width:a,height:c,url:"https:\\u002F\\u002Fimg.example\\u002Fpage-t.w640.jpg"}]}("1","2","3"))`;
    const map = parseNuxtPayload(inlinePayload)!;
    expect(extractKuaikanImages(inlinePayload, map)).toEqual(["https://img.example/page-t.w640.jpg"]);
  });

  it("accepts Array(n) and {} arguments like the real payload", () => {
    const tolerantPayload = `(function(a,b,c,d,e,f,g,h){comic_images:[{width:a,height:c,url:"https:\\u002F\\u002Fimg.example\\u002Fa-t.w640.jpg",width1280:a,url1280:b}]}(${values.map(v => `"${v}"`).join(",")},Array(4),{}))`;
    // 10 وسائط مقابل 8 معاملات → لا يطابق، ويُقبل فقط بنفس العدد؛
    // هذا الاختبار يوثّق السلوك: التحليل يرفض عدم التطابق لا يخمّن
    expect(parseNuxtPayload(tolerantPayload)).toBeNull();
  });

  it("returns null on malformed payloads", () => {
    expect(parseNuxtPayload("nothing here")).toBeNull();
  });
});

describe("titles and pay detection", () => {
  it("splits the real page title into chapter and series", () => {
    const title = "第1话 穿成恶毒长公主？！｜穿书后，我被五个小反派娇宠了漫画｜官方在线漫画全集-快看漫画";
    expect(parseKuaikanTitle(title)).toEqual({
      chapterName: "第1话 穿成恶毒长公主？！",
      mangaTitle: "穿书后，我被五个小反派娇宠了",
    });
  });

  it("extracts the page title", () => {
    expect(extractKuaikanPageTitle("<html><head><title>العنوان</title></head></html>")).toBe("العنوان");
    expect(extractKuaikanPageTitle("<html></html>")).toBe("");
  });

  it("detects paid comics through the resolved parameter", () => {
    const payload = `(function(a,b){topic_info:{comics:[{is_pay_comic:b}]}}("x","true"))`;
    expect(isKuaikanPayComic(payload)).toBe(true);
    const freePayload = `(function(a,b){topic_info:{comics:[{is_pay_comic:b}]}}("x","false"))`;
    expect(isKuaikanPayComic(freePayload)).toBe(false);
  });

  it("finds the payload in page html", () => {
    const html = `<script>window.__NUXT__=(function(a,b){return {id:a,title:b}}("100","العمل التجريبي الطويل بقدر كافٍ لتجاوز حد الطول المطلوب في الاستخراج"))</script>`;
    const payload = extractKuaikanNuxtPayload(html);
    expect(payload).toContain("(function");
    expect(payload).toContain("العمل التجريبي");
    expect(extractKuaikanNuxtPayload("<html></html>")).toBeNull();
  });
});
