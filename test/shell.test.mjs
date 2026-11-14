import assert from "node:assert/strict";
import { test } from "node:test";
import { inputTextArg, isAsciiPrintable, isInt, isPackageName, parseSections, quote, sectionScript } from "../lib/shell.mjs";

test("quote: single quotes survive the device shell", () => {
  assert.equal(quote("plain"), "'plain'");
  assert.equal(quote("it's"), "'it'\\''s'");
  assert.equal(quote("$(reboot); `x`"), "'$(reboot); `x`'");
});

test("inputTextArg: spaces become %s and metacharacters are quoted", () => {
  assert.equal(inputTextArg("hello world"), "'hello%sworld'");
  assert.equal(inputTextArg("#tag ?"), "'#tag%s?'");
  assert.equal(inputTextArg("it's (ok) & $HOME;"), "'it'\\''s%s(ok)%s&%s$HOME;'");
});

test("isAsciiPrintable", () => {
  assert.ok(isAsciiPrintable("Hello, world! ~"));
  assert.ok(!isAsciiPrintable("héllo"));
  assert.ok(!isAsciiPrintable("line\nbreak"));
});

test("isPackageName / isInt", () => {
  assert.ok(isPackageName("com.droiddeck.launcher"));
  assert.ok(isPackageName("dev.example_app.v2"));
  assert.ok(!isPackageName("x; reboot"));
  assert.ok(!isPackageName("com..bad"));
  assert.ok(!isPackageName(""));
  assert.ok(isInt("120") && isInt("-5"));
  assert.ok(!isInt("1.5") && !isInt("12px") && !isInt(""));
});

test("sectionScript / parseSections round trip", () => {
  assert.equal(sectionScript({ a: "getprop x", b: "cat /f 2>/dev/null" }), "echo '@@a'; getprop x; echo '@@b'; cat /f 2>/dev/null");
  assert.deepEqual(parseSections("@@a\r\nvalue one\r\n@@b\r\n\r\n@@c\r\nline1\r\nline2\r\n"), { a: "value one", b: "", c: "line1\nline2" });
  assert.deepEqual(parseSections("noise before\n@@com.example.app\nversionName=1.2\n"), { "com.example.app": "versionName=1.2" });
});
