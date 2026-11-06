// A small markdown renderer (paragraphs, bold, inline code, lists, ### headings, fenced code),
// the same on server and client. A chat reply is re-rendered with it as each token arrives, so
// an unclosed code fence renders as the code so far.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) =>
	esc(s)
		.replace(/`([^`]+)`/g, '<code>$1</code>')
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

export function md(src) {
	const out = [];
	const lines = src.split('\n');
	let para = [];
	let list = null;
	const flush = () => {
		if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
		if (list) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
		para = [];
		list = null;
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith('```')) {
			flush();
			const lang = line.slice(3).trim();
			const code = [];
			for (i++; i < lines.length && !lines[i].startsWith('```'); i++) code.push(lines[i]);
			out.push(`<pre><code${lang ? ` class="language-${lang}"` : ''}>${esc(code.join('\n'))}</code></pre>`);
		} else if (/^#{1,3} /.test(line)) {
			flush();
			const n = line.indexOf(' ');
			out.push(`<h${n + 2}>${inline(line.slice(n + 1))}</h${n + 2}>`);
		} else if (line.startsWith('- ')) {
			if (para.length) {
				out.push(`<p>${inline(para.join(' '))}</p>`);
				para = [];
			}
			(list ??= []).push(line.slice(2));
		} else if (!line.trim()) flush();
		else {
			if (list) {
				out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
				list = null;
			}
			para.push(line);
		}
	}
	flush();
	return out.join('');
}
