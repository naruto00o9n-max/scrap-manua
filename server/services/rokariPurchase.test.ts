import { describe, expect, it } from "vitest";
import {
  classifyRokariBuyResponse,
  parseRokariBuyOffer,
} from "./rokariPurchase";

// المقتطفات من صفحة فصل مقفل حقيقية على rokaricomics.com:
// زر الشراء buyChapter(17334) بسعر 100 عملة ونداء admin-ajax بمفتاح جلسة.
const LOCKED_SNIPPET = `
  <h1 class="lock-title">The Villainous Family Is Against Independence Chapter 103</h1>
  <p class="lock-status">This chapter is locked. Please purchase it to read the full content.</p>
  <button class="btn-enhanced" type="button" onclick="buyChapter(17334)" id="buy-button">
    <span class="btn-text">Buy now for <span class="coin-amount">100</span></span>
  </button>
  <script>
    function buyChapter(id) {
      $.ajax({
        type: "POST",
        url: "https://rokaricomics.com/wp-admin/admin-ajax.php",
        data: {
          action: "buy_chapter",
          id: id,
          nonce: "fbdde5198a"
        },
        success: function (response) { if (response.success) { location.reload(); } }
      });
    }
  </script>
`;

describe("parseRokariBuyOffer", () => {
  it("extracts the chapter id, session nonce and coin price from a locked page", () => {
    expect(parseRokariBuyOffer(LOCKED_SNIPPET)).toEqual({
      chapterPostId: "17334",
      nonce: "fbdde5198a",
      coinCost: 100,
    });
  });

  it("keeps a null price when the page omits the coin amount", () => {
    const withoutPrice = LOCKED_SNIPPET.replace(
      /<span class="coin-amount">100<\/span>/,
      ""
    );
    const offer = parseRokariBuyOffer(withoutPrice);
    expect(offer?.chapterPostId).toBe("17334");
    expect(offer?.coinCost).toBeNull();
  });

  it("rejects pages without a buy button or without the purchase nonce", () => {
    expect(parseRokariBuyOffer("<html>reading-content with images</html>")).toBeNull();
    expect(
      parseRokariBuyOffer(
        LOCKED_SNIPPET.replace(/nonce:\s*"fbdde5198a"/, "nonce: ''")
      )
    ).toBeNull();
  });
});

describe("classifyRokariBuyResponse", () => {
  it("accepts a successful purchase", () => {
    expect(classifyRokariBuyResponse(200, '{"success":true}')).toEqual({ ok: true });
    expect(
      classifyRokariBuyResponse(200, '{"success":true,"data":"Chapter purchased successfully!"}')
    ).toEqual({ ok: true });
  });

  it("maps a login-required rejection to a session failure", () => {
    const outcome = classifyRokariBuyResponse(
      200,
      '{"success":false,"data":"You have to login to buy chapter"}'
    );
    expect(outcome).toMatchObject({ ok: false, kind: "session" });
  });

  it("maps an insufficient-balance rejection with the site message", () => {
    const outcome = classifyRokariBuyResponse(
      200,
      '{"success":false,"data":"Not enough coins"}'
    );
    expect(outcome).toMatchObject({ ok: false, kind: "balance" });
    if (!outcome.ok) expect(outcome.message).toContain("Not enough coins");
  });

  it("passes an explicit site rejection through", () => {
    const outcome = classifyRokariBuyResponse(
      200,
      '{"success":false,"data":"Something went wrong"}'
    );
    expect(outcome).toMatchObject({ ok: false, kind: "site" });
    if (!outcome.ok) expect(outcome.message).toContain("Something went wrong");
  });

  it("treats non-JSON bodies (0 / -1 / html) as an expired session", () => {
    for (const body of ["0", "-1", "<html>forbidden</html>", ""]) {
      const outcome = classifyRokariBuyResponse(200, body);
      expect(outcome).toMatchObject({ ok: false, kind: "unexpected" });
    }
  });
});
