// Готовые ссылки на поиск по магазинам. Работают без ИИ и без ключей.
const enc = encodeURIComponent;

export const SHOPS = [
  { name: "Lamoda", url: (q) => `https://www.lamoda.ru/catalogsearch/result/?q=${enc(q)}` },
  { name: "Wildberries", url: (q) => `https://www.wildberries.ru/catalog/0/search.aspx?search=${enc(q)}` },
  { name: "Ozon", url: (q) => `https://www.ozon.ru/search/?text=${enc(q)}` },
  { name: "Яндекс Маркет", url: (q) => `https://market.yandex.ru/search?text=${enc(q)}` },
  { name: "Google Покупки", url: (q) => `https://www.google.com/search?tbm=shop&q=${enc(q)}` },
  { name: "ASOS", url: (q) => `https://www.asos.com/search/?q=${enc(q)}` },
  { name: "Zara", url: (q) => `https://www.zara.com/ww/en/search?searchTerm=${enc(q)}` },
  { name: "Pinterest", url: (q) => `https://www.pinterest.com/search/pins/?q=${enc(q)}` },
];
