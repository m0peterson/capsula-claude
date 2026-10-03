import test from "node:test";
import assert from "node:assert/strict";
import { parseModelJson, extractJson } from "../public/js/util.js";

const ok = (text, expected, repaired = false) => {
  const r = parseModelJson(text);
  assert.deepEqual(r.value, expected);
  assert.equal(r.repaired, repaired, `repaired flag for ${JSON.stringify(text).slice(0, 60)}`);
};

test("чистый JSON и ```-обёртка", () => {
  ok('{"a":1}', { a: 1 });
  ok('```json\n{"a":[1,2]}\n```', { a: [1, 2] });
  ok('Вот результат:\n```\n{"a":1}\n```\nГотово.', { a: 1 });
});

test("текст до и после, в том числе со скобками", () => {
  ok('{"a":1,"b":[1,2]}\nГотово, надеюсь помогло.', { a: 1, b: [1, 2] });
  ok('{"a":1} Если нужно {ещё} — пишите', { a: 1 });
  ok('Анализ [фото 1]: {"a":1}', { a: 1 });
  ok('Вот {результат}: {"a":1}', { a: 1 });
});

test("регрессия: скобка `[` в тексте перед JSON не ломает разбор", () => {
  // Старый код брал первую `[` и последнюю `]` и падал с «Expected ',' or ']' after array element».
  ok('Цвета [см. палитру] ниже: {"colors":[{"n":"a"},{"n":"b"}],"x":1}', { colors: [{ n: "a" }, { n: "b" }], x: 1 });
});

test("рассуждения в content: <think> и одиночный </think>", () => {
  ok('<think>надо {подумать} [так]</think>{"a":1}', { a: 1 });
  ok('рассуждение [1] {x}</think>\n{"a":2}', { a: 2 });
});

test("массив в корне", () => {
  ok('[{"x":1}]', [{ x: 1 }]);
});

test("ремонт: неэкранированные кавычки, запятые, комментарии, одинарные кавычки", () => {
  ok('{"a":"он сказал "привет" ему","b":[{"n":"x"},{"n":"y"}]}', { a: 'он сказал "привет" ему', b: [{ n: "x" }, { n: "y" }] }, true);
  ok('{"a":[1,2,],}', { a: [1, 2] }, true);
  ok('{"a":1, // комментарий\n "b":2}', { a: 1, b: 2 }, true);
  ok("{'a':'x'}", { a: "x" }, true);
  ok('Анализ [фото 1]: {"a":"x "y" z", "b":[1,2,]}', { a: 'x "y" z', b: [1, 2] }, true);
});

test("оборванный ответ достраивается целиком, а не превращается во вложенный объект", () => {
  // Регрессия: поиск «последней }» давал {"b":1} или обрезанный кусок вместо всего ответа.
  ok('{"a":{"b":1}, "c": [{"x":1}, {"y":"обор', { a: { b: 1 }, c: [{ x: 1 }, { y: "обор" }] }, true);
});

test("нет JSON: ошибка с сырым ответом", () => {
  assert.throws(
    () => parseModelJson("просто текст"),
    (e) => e.raw === "просто текст" && /JSON/.test(e.message),
  );
  assert.throws(() => extractJson(""));
});

test("пустой объект допустим, проза со скобками не принимается за ответ", () => {
  ok("{}", {});
  for (const junk of ["{ не json ]]", "Извините, не могу {помочь} с этим.", "[фото 1] и [фото 2]", "Ответ: {текст без кавычек}"]) {
    assert.throws(
      () => parseModelJson(junk),
      (e) => e.raw === junk,
      junk,
    );
  }
});

// --- Регрессии из состязательного ревью -----------------------------------------------------------------
const J = '{"color_type":{"season":"осень"},"body":{"type":"груша"}}';
const JV = { color_type: { season: "осень" }, body: { type: "груша" } };
const EXPECT = { expect: ["color_type", "body"] };

test("валидные, но посторонние фрагменты в прозе до ответа не побеждают его", () => {
  for (const prose of [
    "Анализ [1]:",
    "Размеры [42, 44, 46] подойдут.",
    "- [ ] Проверить",
    "Пустой объект {} не нужен.",
    "Ссылки [1](https://a.b) и [2]:",
  ]) {
    const r = parseModelJson(`${prose}\n${J}`, EXPECT);
    assert.deepEqual(r.value, JV, prose);
    assert.equal(r.repaired, false);
  }
});

test("битый ответ побеждает валидный мусор после него", () => {
  const broken = '{"color_type":{"season":"он сказал "осень" мне"},"body":{"type":"груша"}}';
  for (const tail of ["\nПримечание: см. [1]", '\nФормат: {"ok":true}', "\n[42, 44]"]) {
    const r = parseModelJson(broken + tail, EXPECT);
    assert.equal(r.repaired, true, tail);
    assert.equal(r.value.color_type.season, 'он сказал "осень" мне', tail);
    assert.deepEqual(r.value.body, { type: "груша" });
  }
});

test("незакрытая скобка в прозе до ответа не оборачивает ответ", () => {
  assert.deepEqual(parseModelJson(`Анализ [фото:\n${J}`, EXPECT).value, JV);
  assert.deepEqual(parseModelJson(`Анализ {фото:\n${J}`, EXPECT).value, JV);
});

test("много скобочных групп в прозе до ответа", () => {
  const prose = Array.from({ length: 12 }, (_, i) => `[${i + 1}]`).join(" ");
  assert.deepEqual(parseModelJson(`${prose}\n${J}`, EXPECT).value, JV);
});

test("три бэктика внутри строки не отнимают ответ", () => {
  const withFence = '{"color_type":{"season":"осень"},"body":{"type":"груша"},"note":"пример: ```json [{\\"id\\":1}] ``` конец"}';
  const r = parseModelJson(withFence, EXPECT);
  assert.equal(r.value.color_type.season, "осень");
  assert.equal(r.value.body.type, "груша");
});

test("незакрытый <think> с черновиком JSON не принимается за ответ", () => {
  assert.throws(() => parseModelJson('<think>черновик: {"items":[]} подумаю ещё'));
  assert.deepEqual(parseModelJson(`<think>раз</think>${J}`, EXPECT).value, JV);
  assert.deepEqual(parseModelJson(`<THINK>раз {x}</THINK>${J}`, EXPECT).value, JV);
});

test("ответ в обёртке с одним ключом разворачивается, если ждём другие ключи", () => {
  assert.deepEqual(parseModelJson(`{"analysis":${J}}`, EXPECT).value, JV);
  assert.deepEqual(parseModelJson('{"analysis":{"x":1}}', EXPECT).value, { analysis: { x: 1 } });
});

test("expect выбирает нужный объект среди нескольких", () => {
  const r = parseModelJson('{"meta":{"a":1,"b":2,"c":3,"d":4}}\n{"items":[1]}', { expect: ["items"] });
  assert.deepEqual(r.value, { items: [1] });
});

test("скорость: ответы около 200 КБ и патологические входы", () => {
  const big = {
    items: Array.from({ length: 1500 }, (_, i) => ({
      index: i,
      name: `Вещь номер ${i} с длинным описанием крой ткань сезон`,
      notes: "x".repeat(80),
    })),
  };
  const bigText = JSON.stringify(big);
  assert.ok(bigText.length > 190_000, `размер ${bigText.length}`);

  const timed = (label, fn, limitMs = 1500) => {
    const t0 = performance.now();
    const out = fn();
    const ms = performance.now() - t0;
    assert.ok(ms < limitMs, `${label}: ${Math.round(ms)} мс`);
    return out;
  };

  assert.equal(timed("чистый", () => parseModelJson(bigText, { expect: ["items"] })).value.items.length, 1500);
  const cut = bigText.slice(0, Math.floor(bigText.length * 0.7));
  assert.ok(timed("оборванный", () => parseModelJson(cut, { expect: ["items"] })).value.items.length > 900);
  const quoted = bigText.replace('"Вещь номер 700', '"он сказал "привет" Вещь номер 700');
  assert.equal(timed("битый", () => parseModelJson(quoted, { expect: ["items"] })).repaired, true);
  assert.throws(() => timed("незакрытое ограждение и пробелы", () => parseModelJson("```" + " ".repeat(200_000))));
  assert.throws(() => timed("много think", () => parseModelJson("<think>".repeat(20_000))));
  assert.throws(() => timed("много скобок", () => parseModelJson("[".repeat(100_000))));
});

// --- Регрессии второго раунда ревью --------------------------------------------------------------------
const ITEMS = Array.from({ length: 5 }, (_, i) => ({ index: i + 1, name: `Вещь ${i}`, category: "top" }));
const WRAP = { expect: ["items"] };

test("оборванный голый массив чинится целиком и помечается починенным", () => {
  const text = JSON.stringify(ITEMS);
  const cut = text.slice(0, text.length - 25);
  const r = parseModelJson(cut, WRAP);
  assert.equal(r.repaired, true);
  assert.ok(Array.isArray(r.value) && r.value.length >= 4, `получено ${JSON.stringify(r.value).slice(0, 80)}`);
});

test("голый массив с нечётной кавычкой не превращается в одну запись", () => {
  const odd = '[{"index":1,"name":"Сапоги","notes":"каблук 3" высота"},{"index":2,"name":"Платье"},{"index":3,"name":"Юбка"}]';
  const r = parseModelJson(odd, WRAP);
  assert.ok(Array.isArray(r.value) && r.value.length === 3);
  assert.equal(r.repaired, true);
});

test("непочиняемая кавычка: фрагмент внутри незакрытой скобки не принимается, чтобы сработал повтор", () => {
  const odd = JSON.stringify({ items: ITEMS }).replace('"Вещь 1"', '"Вещь 5" 1"');
  assert.throws(() => parseModelJson(odd, WRAP));
  // Битый ответ с хвостовой прозой, содержащей скобки, починить нельзя. Старый парсер тоже падал,
  // но фрагмент из середины как ответ принимать нельзя: нужен повтор запроса.
  const brokenWithTail =
    '{"items":[{"index":1,"name":"Сапоги","notes":"каблук 3" высота"},{"index":2,"name":"Платье"}]}\nЕсли нужно {уточнить} — пишите';
  assert.throws(() => parseModelJson(brokenWithTail, WRAP));
});

test("результат из вложенного фрагмента помечается nested", () => {
  const r = parseModelJson(`Анализ [фото:\n${J}`, EXPECT);
  assert.deepEqual(r.value, JV);
  assert.equal(r.nested, true);
  assert.equal(parseModelJson(J, EXPECT).nested, false);
});

test("чеклист в прозе не съедает бюджет ремонта битого ответа", () => {
  const broken = '{"color_type":{"season":"он сказал "осень" мне"},"body":{"type":"груша"},"summary":"ok"}';
  const prose = "Проверено:\n- [x] цветотип\n- [x] фигура\n- [x] стили\n- [x] силуэты\n- [x] итог\n\nИтог:\n";
  const r = parseModelJson(prose + broken, EXPECT);
  assert.equal(r.repaired, true);
  assert.equal(r.value.color_type.season, 'он сказал "осень" мне');
});

test("одиночный </think> внутри самого ответа не стирает начало ответа", () => {
  const a = JSON.stringify({ color_type: { season: "осень", reasoning: "теги </think> в тексте" }, body: { type: "груша" }, summary: "x" });
  const r = parseModelJson(a, EXPECT);
  assert.equal(r.value.color_type.season, "осень");
  assert.equal(r.value.summary, "x");
  // а настоящий одиночный закрывающий тег после рассуждений по-прежнему срезается
  assert.deepEqual(parseModelJson(`рассуждение [1] {x}</think>\n${J}`, EXPECT).value, JV);
});
