import assert from "node:assert/strict";
import test from "node:test";
import { AuthError, QuotaError, TooLargeError, WebDav, filesFromPropfind, type HttpResponse } from "./webdav.ts";

const xml = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
<d:response><d:href>/webdav/alkov/</d:href><d:propstat><d:prop>
<d:displayname></d:displayname><d:resourcetype><d:collection/></d:resourcetype>
<d:getlastmodified>Sun, 18 Oct 2026 09:10:00 GMT</d:getlastmodified><d:getetag>&quot;root&quot;</d:getetag>
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>/webdav/alkov/notes/hello%20world.md</d:href><d:propstat><d:prop>
<d:displayname>hello world.md</d:displayname><d:getcontentlength>12</d:getcontentlength>
<d:getcontenttype>text/markdown</d:getcontenttype><d:resourcetype></d:resourcetype>
<d:getlastmodified>Sun, 18 Oct 2026 09:11:00 GMT</d:getlastmodified><d:getetag>&quot;abc&quot;</d:getetag>
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>/webdav/alkov/dir/</d:href><d:propstat><d:prop>
<d:resourcetype><d:collection/></d:resourcetype>
<d:getlastmodified>Sun, 18 Oct 2026 09:11:00 GMT</d:getlastmodified><d:getetag>&quot;dir&quot;</d:getetag>
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;

test("propfind keeps files under the remote folder", () => {
	const files = filesFromPropfind(xml, "/webdav/alkov");
	assert.deepEqual(files, [{
		path: "notes/hello world.md",
		size: 12,
		mtime: Date.parse("Sun, 18 Oct 2026 09:11:00 GMT"),
		etag: "abc",
	}]);
});

test("list sends one infinity propfind with basic auth", async () => {
	const seen: { method: string; url: string; headers: Record<string, string> }[] = [];
	const dav = new WebDav(async (request) => {
		seen.push({ method: request.method, url: request.url, headers: request.headers });
		return text(207, xml);
	}, { server: "https://syncup.ru/webdav/", folder: "alkov", username: "a@b.c", password: "secret" });
	const files = await dav.list();
	assert.equal(files.length, 1);
	assert.equal(seen[0].method, "PROPFIND");
	assert.equal(seen[0].url, "https://syncup.ru/webdav/alkov/");
	assert.equal(seen[0].headers.Depth, "infinity");
	assert.equal(seen[0].headers.Authorization, `Basic ${btoa("a@b.c:secret")}`);
});

test("put and delete use the encoded vault path", async () => {
	const seen: { method: string; url: string; body?: Uint8Array }[] = [];
	const dav = new WebDav(async (request) => {
		seen.push({ method: request.method, url: request.url, body: request.body });
		if (request.method === "GET") return { status: 200, headers: { etag: '"abc"' }, body: new Uint8Array([1, 2, 3]) };
		return { status: request.method === "PUT" ? 201 : 204, headers: { etag: '"def"' }, body: new Uint8Array() };
	}, { server: "https://syncup.ru/webdav", folder: "alkov", username: "a@b.c", password: "s" });
	const body = new Uint8Array([9]);
	const put = await dav.put("notes/hello world.md", body);
	assert.equal(put.etag, "def");
	assert.equal(seen[0].url, "https://syncup.ru/webdav/alkov/notes/hello%20world.md");
	assert.deepEqual(seen[0].body, body);
	const got = await dav.get("notes/hello world.md");
	assert.equal(got.etag, "abc");
	assert.deepEqual(got.body, new Uint8Array([1, 2, 3]));
	await dav.remove("notes/hello world.md");
	assert.equal(seen[2].method, "DELETE");
});

test("auth, quota, and size errors are distinct", async () => {
	const dav = (status: number) => new WebDav(async () => text(status, "nope"), {
		server: "https://syncup.ru/webdav", folder: "", username: "a@b.c", password: "s",
	});
	await assert.rejects(dav(401).list(), AuthError);
	await assert.rejects(dav(507).put("a.md", new Uint8Array([1])), QuotaError);
	await assert.rejects(dav(413).put("a.md", new Uint8Array([1])), TooLargeError);
});

function text(status: number, body: string): HttpResponse {
	return { status, headers: {}, body: new TextEncoder().encode(body) };
}
