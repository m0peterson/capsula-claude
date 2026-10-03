// Предзагрузка для теста dev-сервера: «провайдер» молчит, пока клиент не отменит запрос, и пишет об этом в stdout.
globalThis.fetch = (url, init) =>
  new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      console.log("UPSTREAM_ABORTED");
      reject(new DOMException("aborted", "AbortError"));
    });
    console.log("UPSTREAM_STARTED");
  });
