// The example's source code. It exists so that the documentation has a file of the repository to link
// to: a link from docs/ to a file outside docs/ becomes a link to that file on GitHub.

/** A Cloudflare Worker that answers every request with a greeting. */
export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    return new Response(`Hello from ${pathname}\n`, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
