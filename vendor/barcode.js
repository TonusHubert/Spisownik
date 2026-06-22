(function () {
  "use strict";

  const EAN_L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
  const EAN_G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
  const EAN_R = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"];
  const EAN13_PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];
  const CODE128 = [
    "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
    "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
    "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
    "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
    "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
    "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
    "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
    "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
    "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
    "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
    "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
  ];

  function validEan(value) {
    if (!/^\d{8}$|^\d{13}$/.test(value)) return false;
    const digits = [...value].map(Number);
    const check = digits.pop();
    const sum = digits.reduce((total, digit, index) => {
      const weight = (digits.length - index) % 2 === 1 ? 3 : 1;
      return total + digit * weight;
    }, 0);
    return (10 - (sum % 10)) % 10 === check;
  }

  function encodeEan(value) {
    if (value.length === 8) {
      return `101${[...value.slice(0, 4)].map((digit) => EAN_L[digit]).join("")}01010${[...value.slice(4)].map((digit) => EAN_R[digit]).join("")}101`;
    }
    const parity = EAN13_PARITY[Number(value[0])];
    const left = [...value.slice(1, 7)].map((digit, index) => (parity[index] === "L" ? EAN_L : EAN_G)[digit]).join("");
    const right = [...value.slice(7)].map((digit) => EAN_R[digit]).join("");
    return `101${left}01010${right}101`;
  }

  function encodeCode128(value) {
    const safe = [...value].map((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 && code <= 126 ? code - 32 : 31;
    });
    const values = [104, ...safe];
    const checksum = (104 + safe.reduce((sum, code, index) => sum + code * (index + 1), 0)) % 103;
    values.push(checksum, 106);
    let bars = "";
    for (const code of values) {
      [...CODE128[code]].forEach((width, index) => {
        bars += `${index % 2 === 0 ? "1" : "0"}`.repeat(Number(width));
      });
    }
    return bars;
  }

  function draw(svg, value, options = {}) {
    const text = String(value ?? "").trim();
    if (!svg || !text) return false;
    const isEan = validEan(text);
    const bars = isEan ? encodeEan(text) : encodeCode128(text);
    const quiet = isEan ? 11 : 12;
    const width = bars.length + quiet * 2;
    const barHeight = options.barHeight || 64;
    const textHeight = options.showText === false ? 0 : 22;
    const height = barHeight + textHeight + 8;
    let paths = "";
    for (let index = 0; index < bars.length; index += 1) {
      if (bars[index] === "1") paths += `<rect x="${quiet + index}" y="4" width="1" height="${barHeight}" />`;
    }
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `Kod kreskowy ${text}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.innerHTML = `<rect width="${width}" height="${height}" fill="#fff"/>`
      + `<g fill="#000">${paths}</g>`
      + (textHeight ? `<text x="${width / 2}" y="${height - 4}" text-anchor="middle" font-family="ui-monospace,monospace" font-size="14" letter-spacing="2" fill="#000">${text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]) || char)}</text>` : "");
    svg.dataset.format = isEan ? `EAN-${text.length}` : "CODE128";
    return true;
  }

  window.SpisownikBarcode = { draw, validEan };
})();
