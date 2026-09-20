"""Local, bounded DOCX/PDF extraction; stdout is the artifact manifest, never a command."""
import base64
import io
import json
import re
import sys
import zipfile
from importlib.metadata import version
from pathlib import PurePosixPath
from html.parser import HTMLParser

MAX_OUTPUT = 32 * 1024 * 1024


def extract(data, kind):
    files, warnings, sections = [], [], []
    total = 0

    def asset(data, suffix, location):
        nonlocal total
        total += len(data)
        if total > MAX_OUTPUT or len(files) >= 300:
            raise ValueError('图片数量或展开大小超过限制，未创建导入任务')
        supported = suffix.lower() in ('.png', '.jpg', '.jpeg', '.gif', '.webp')
        name = f'images/{len(files)+1:04d}{suffix.lower() if supported else ".bin"}'
        files.append({'name': name, 'base64': base64.b64encode(data).decode('ascii')})
        if not supported:
            warnings.append(f'{location}：图片格式不能预览，保留提取字节供下载及原件对照')
        return f'{"!" if supported else ""}[{location}](./{name})'

    def escaped(text):
        return re.sub(r'([\\`*_{}\[\]()<>#!|~])', r'\\\1', text).replace('\r', '').replace('\n', ' / ')

    if kind == 'docx':
        from docx import Document
        from docx.text.paragraph import Paragraph
        from docx.oxml.ns import qn
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > 3000 or sum(x.file_size for x in entries) > 64 * 1024 * 1024:
                raise ValueError('DOCX 展开大小或文件数超过限制')
            if len({x.filename for x in entries}) != len(entries):
                raise ValueError('DOCX 包含重复条目，无法可靠核对')
            media = {x.filename: archive.read(x) for x in entries if x.filename.startswith('word/media/') and not x.is_dir()}
        document = Document(io.BytesIO(data))
        warnings.append('DOCX 使用正文块/段落位置，页码不可用；文本框提取段落文字，不保留浮动排版。页眉页脚、批注、修订、图表和嵌入对象未完整解析，请对照原件。图片内容未识别，外链未读取。')
        image_links, used = {}, set()

        def pictures(element, location):
            result = []
            for node in element.xpath('.//a:blip'):
                rid = node.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed')
                relationship = document.part.rels.get(rid)
                if relationship is None or relationship.is_external:
                    warnings.append(f'{location}：外部或缺失图片未读取')
                    continue
                part = relationship.target_part
                key = str(part.partname).lstrip('/')
                used.add(key)
                if key not in image_links:
                    image_links[key] = asset(part.blob, PurePosixPath(key).suffix, location+' 图片')
                result.append(image_links[key])
            return result

        for index, block in enumerate(document.iter_inner_content(), 1):
            if index > 10000:
                raise ValueError('DOCX 正文块数超过限制')
            location = f'正文块 {index}'
            sections.append(f'\n> 来源：{location}（DOCX 页码不可用）\n')
            if isinstance(block, Paragraph):
                heading = re.search(r'(?:Heading|标题)\s*([1-6])', block.style.name or '', re.I)
                sections.append(('#' * int(heading[1]) + ' ' if heading else '') + escaped(block.text))
            else:
                rows = [[escaped(cell.text) for cell in row.cells] for row in block.rows]
                width = max((len(row) for row in rows), default=0)
                if width:
                    # No inferred header: preserve every source row below a neutral Markdown header.
                    lines = ['| '+' | '.join(f'列 {i+1}' for i in range(width))+' |', '| '+' | '.join(['---']*width)+' |']
                    lines.extend('| '+' | '.join(row+['']*(width-len(row)))+' |' for row in rows)
                    sections.append('\n'.join(lines))
                if block._element.xpath('.//w:tbl'):
                    warnings.append(f'{location}：嵌套表格需对照原件，未保证层级完整')
            # Paragraph.text omits shape text. Keep code/log line breaks and indentation inside anchored text boxes.
            for box_number, box in enumerate(block._element.xpath('.//w:txbxContent'), 1):
                text = '\n'.join(Paragraph(p, block._parent).text for p in box.iter(qn('w:p')))
                if text.strip():
                    sections.extend([f'> 来源：{location} / 文本框 {box_number}（仅文字，浮动位置未还原）', '\n'.join('    '+line for line in text.split('\n'))])
            sections.extend(pictures(block._element, location))
        for key, value in media.items():
            if key not in used:
                sections.extend(['\n> 来源位置不可用：原件内其他图片\n', asset(value, PurePosixPath(key).suffix, '位置不可用的图片')])
        parser = 'python-docx ' + version('python-docx')
    elif kind == 'pdf':
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(data), strict=True)
        if reader.is_encrypted:
            raise ValueError('加密 PDF 不支持；请提供已解密的授权副本')
        if not 0 < len(reader.pages) <= 200:
            raise ValueError('PDF 页数须在 1—200 页之间')
        warnings.append('PDF 按页保留文字布局；多栏阅读顺序、标题层级及表格结构未认证。图片未识别，矢量图、注释、表单和嵌入附件未完整提取；原件完整保留。')
        for number, page in enumerate(reader.pages, 1):
            sections.append(f'\n## 第 {number} 页\n')
            text = ''
            try:
                content = page.get_contents()
                if content and len(content.get_data()) > 8 * 1024 * 1024:
                    raise ValueError('页面内容流过大')
                text = page.extract_text(extraction_mode='layout', layout_mode_strip_rotated=False)
                if not any(char.isalnum() for char in text):
                    warnings.append(f'第 {number} 页：无有效文字，可能为扫描页或空白页，需要 OCR 或人工核对')
                    sections.append('> 未识别：无有效文字，需要 OCR 或人工核对。')
                else:
                    sections.append('\n'.join('    '+line for line in text.splitlines()))
            except Exception:
                warnings.append(f'第 {number} 页：文字提取失败，需要人工核对；未标记为全文完成')
                sections.append('> 未识别：本页文字提取失败。')
            try:
                for key in page.images.keys():
                    try:
                        item = page.images[key]
                        sections.append(asset(item.data, PurePosixPath(item.name).suffix, f'第 {number} 页图片'))
                    except ValueError:
                        raise
                    except Exception:
                        warnings.append(f'第 {number} 页：一张图片提取失败，仍保留于 PDF 原件')
            except ValueError:
                raise
            except Exception:
                warnings.append(f'第 {number} 页：图片清单读取失败，请对照 PDF 原件')
        parser = 'pypdf ' + version('pypdf')
    elif kind == 'html':
        # Preserve the fetched bytes separately; parse inert static text without fetching assets or running scripts.
        charset = re.search(br'<meta\b[^>]*charset\s*=\s*["\x27]?\s*([a-zA-Z0-9_-]+)', data[:8192], re.I)
        encoding = charset.group(1).decode('ascii').lower() if charset else 'utf-8'
        if encoding not in ('utf-8', 'utf8', 'gbk', 'gb2312', 'gb18030', 'big5'):
            raise ValueError('网页字符编码未支持，请导出为 UTF-8 文件')
        text = data.decode(encoding, errors='strict')

        class StaticText(HTMLParser):
            def __init__(self):
                super().__init__(convert_charrefs=True)
                self.parts, self.ignored = [], []
                self.nodes = 0

            def handle_starttag(self, tag, attrs):
                self.nodes += 1
                if self.nodes > 100000:
                    raise ValueError('网页结构超过解析限制')
                if tag in ('head', 'script', 'style', 'template', 'noscript', 'svg', 'iframe', 'object'):
                    self.ignored.append(tag)
                elif not self.ignored and tag in ('p', 'div', 'br', 'li', 'tr', 'section', 'article', 'h1', 'h2', 'h3', 'h4'):
                    self.parts.append('\n')

            def handle_endtag(self, tag):
                if tag in self.ignored:
                    self.ignored = self.ignored[:self.ignored.index(tag)]
                elif not self.ignored and tag in ('p', 'div', 'li', 'tr', 'section', 'article', 'h1', 'h2', 'h3', 'h4'):
                    self.parts.append('\n')

            def handle_data(self, value):
                if not self.ignored:
                    self.parts.append(value)

        document = StaticText()
        document.feed(text)
        document.close()
        plain = re.sub(r'\n[ \t\r]*\n(?:[ \t\r]*\n)*', '\n\n', ''.join(document.parts)).strip()
        if not plain:
            raise ValueError('网页没有可提取的静态正文，请使用客户端导出')
        if any(marker in plain[:3000] for marker in ('环境异常', '完成验证后即可继续访问', '访问过于频繁')):
            raise ValueError('网页返回访问验证或限流提示，未把提示页当正文导入')
        fence = '`' * max(3, max((len(m.group()) + 1 for m in re.finditer(r'`+', plain)), default=3))
        sections.append(f'{fence}text\n{plain}\n{fence}')
        warnings.append('仅提取下载时 HTML 的静态文字，可能包含导航等页面文字；不执行脚本，不读取动态正文、图片、附件、音视频或外链。网页快照以 .bin 保存供下载，不在门户执行。请对照原网页核对完整性。')
        parser = 'Python html.parser / static text v1'
    else:
        raise ValueError('不支持的解析格式')
    markdown = '# 解析正文（未审核）\n\n' + '\n\n'.join('> '+w for w in warnings) + '\n\n' + '\n\n'.join(sections) + '\n'
    if len(markdown.encode('utf-8')) > 4 * 1024 * 1024:
        raise ValueError('解析文字超过 4 MiB，未创建导入任务')
    return {'parser': parser, 'warnings': warnings, 'markdown': markdown, 'assets': files}


if __name__ == '__main__':
    try:
        request = json.loads(sys.stdin.buffer.read(24 * 1024 * 1024))
        result = extract(base64.b64decode(request['base64'], validate=True), request['format'])
        print(json.dumps(result, ensure_ascii=True))
    except ImportError:
        print(json.dumps({'error': '未安装格式解析依赖，请运行 python -m pip install -r requirements-formats.txt'}))
        sys.exit(1)
    except Exception as error:
        message = str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError) else '文件损坏或解析失败；原件未写入知识库'
        print(json.dumps({'error': message}, ensure_ascii=True))
        sys.exit(1)
