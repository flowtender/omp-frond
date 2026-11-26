export async function formatEvalJavaScript(source: string): Promise<string> {
  if (/^\s*%/.test(source)) return source;
  try {
    const [{ format }, babel, estree] = await Promise.all([
      import("prettier/standalone"),
      import("prettier/plugins/babel"),
      import("prettier/plugins/estree"),
    ]);
    const formatted = await format(source, { parser: "babel", plugins: [babel.default, estree.default] });
    return source.endsWith("\n") ? formatted : formatted.replace(/\n$/, "");
  } catch {
    // A cell may be incomplete or use syntax the formatter doesn't recognize.
    return source;
  }
}
