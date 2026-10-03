// Предзагрузка для теста dev-сервера: «провайдер» отдаёт кусок потока и рвёт соединение ошибкой.
const enc = new TextEncoder();
globalThis.fetch = async () => {
  let sent = false;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"{\\"a\\":"}}]}\n\n'));
        } else controller.error(new TypeError("terminated"));
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
};
