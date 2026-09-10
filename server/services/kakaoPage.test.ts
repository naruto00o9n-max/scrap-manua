import { describe, expect, it } from "vitest";
import {
  fetchKakaoViewer,
  parseKakaoPageUrl,
  parseKakaoViewerResponse,
  stripSeriesTitlePrefix,
  type KakaoViewerResponse,
} from "./kakaoPage";

describe("kakao page url parsing", () => {
  it("parses the redirected content/viewer link into series and product ids", () => {
    expect(parseKakaoPageUrl("https://page.kakao.com/content/49361421/viewer/49402089")).toEqual({
      seriesId: "49361421",
      productId: "49402089",
    });
  });

  it("parses the legacy viewer link with a productId query", () => {
    expect(parseKakaoPageUrl("https://page.kakao.com/viewer?productId=49402089")).toEqual({
      seriesId: null,
      productId: "49402089",
    });
  });

  it("parses the content page with an episode productId query", () => {
    expect(
      parseKakaoPageUrl("https://page.kakao.com/content/49361421?tab=episode&productId=49402089")
    ).toEqual({ seriesId: "49361421", productId: "49402089" });
  });

  it("treats a bare content link as a series link without productId", () => {
    expect(parseKakaoPageUrl("https://page.kakao.com/content/49361421?tab=episode")).toEqual({
      seriesId: "49361421",
      productId: null,
    });
  });

  it("rejects non-numeric productId values and other hosts and garbage", () => {
    expect(parseKakaoPageUrl("https://page.kakao.com/viewer?productId=abc")).toEqual({
      seriesId: null,
      productId: null,
    });
    expect(parseKakaoPageUrl("https://page.kakao.com/search?keyword=x")).toBeNull();
    expect(parseKakaoPageUrl("https://webtoons.com/episode/1")).toBeNull();
    expect(parseKakaoPageUrl("not a url")).toBeNull();
  });
});

describe("kakao viewer response parsing", () => {
  const fixture: KakaoViewerResponse = {
    item: {
      uid: 1806700,
      product_id: 49402089,
      title: "정령왕 엘퀴네스 1화",
      is_free: true,
    },
    series_item: { series_id: 49361421, title: "정령왕 엘퀴네스" },
    viewer_data: {
      imageDownloadData: {
        files: [
          { secureUrl: "https://page-edge.kakao.com/sdownload/resource?kid=a&signature=x" },
          { secureUrl: "https://page-edge.kakao.com/sdownload/resource?kid=b&signature=y" },
        ],
      },
    },
  };

  it("maps a free episode into titles and signed page urls", () => {
    const parsed = parseKakaoViewerResponse(fixture, "49361421", "49402089");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.viewer.mangaTitle).toBe("정령왕 엘퀴네스");
    expect(parsed.viewer.chapterName).toBe("1화");
    expect(parsed.viewer.isFree).toBe(true);
    expect(parsed.viewer.pages).toHaveLength(2);
    expect(parsed.viewer.pages[0]).toContain("page-edge.kakao.com");
  });

  it("maps the unpaid-item result code to a locked outcome", () => {
    const parsed = parseKakaoViewerResponse(
      { result_code: -200, message: "구매하지 않은 상품입니다.", message_key: "api_content_not_purchased_item" },
      "49361421",
      "49925913"
    );
    expect(parsed).toMatchObject({ ok: false, locked: true });
  });

  it("maps other error codes to an explicit failure message", () => {
    const parsed = parseKakaoViewerResponse({ result_code: -500, message: "실패" }, "1", "2");
    expect(parsed).toMatchObject({ ok: false, locked: false });
    if (!parsed.ok) expect(parsed.message).toContain("-500");
  });

  it("rejects a success payload with no downloadable files", () => {
    const parsed = parseKakaoViewerResponse(
      { item: { title: "1화" }, series_item: { title: "عمل" }, viewer_data: { imageDownloadData: { files: [] } } },
      "1",
      "2"
    );
    expect(parsed).toMatchObject({ ok: false, locked: false });
  });

  it("strips the series title prefix from chapter titles", () => {
    expect(stripSeriesTitlePrefix("정령왕 엘퀴네스 12화", "정령왕 엘퀴네스")).toBe("12화");
    expect(stripSeriesTitlePrefix("12화", "정령왕 엘퀴네스")).toBe("12화");
    expect(stripSeriesTitlePrefix("정령왕 엘퀴네스", "정령왕 엘퀴네스")).toBe("정령왕 엘퀴네스");
  });

  it("sends the page.kakao.com referer and origin headers to the bff endpoint", async () => {
    let capturedHeaders: Record<string, string> | null = null;
    let capturedUrl = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      capturedUrl = String(input);
      capturedHeaders = init?.headers ?? null;
      return new Response(
        JSON.stringify({
          item: { product_id: 2, title: "عمل 1화", is_free: true },
          series_item: { series_id: 1, title: "عمل" },
          viewer_data: { imageDownloadData: { files: [{ secureUrl: "https://page-edge.kakao.com/x" }] } },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;
    try {
      const result = await fetchKakaoViewer("1", "2");
      expect(result.ok).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(capturedUrl).toContain("bff-page.kakao.com/api/gateway/api/v1/viewer/data");
    expect(capturedUrl).toContain("series_id=1");
    expect(capturedUrl).toContain("product_id=2");
    expect(capturedHeaders?.referer).toBe("https://page.kakao.com/");
    expect(capturedHeaders?.origin).toBe("https://page.kakao.com");
  });
});
