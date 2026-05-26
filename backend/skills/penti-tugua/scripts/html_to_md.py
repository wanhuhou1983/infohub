import sys, json, re

def html_to_md(html):
    """HTML to Markdown converter for dapenti articles.
    
    Handles:
    - GBK-sourced HTML with \\r characters
    - dapenti boilerplate (免责申明, title header, date line, ads)
    - Excessive whitespace from table indentation
    """
    # 1. Normalize line endings FIRST
    html = html.replace('\r\n', '\n').replace('\r', '\n')
    
    # 2. Remove script and style blocks
    html = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL)
    html = re.sub(r'<style[^>]*>.*?</style>', '', html, flags=re.DOTALL)
    
    # 3. Remove HTML comments
    html = re.sub(r'<!--.*?-->', '', html, flags=re.DOTALL)
    
    # 4. Remove ad blocks (adsbygoogle)
    html = re.sub(r'<ins[^>]*class=["\']adsbygoogle["\'][^>]*>.*?</ins>', '', html, flags=re.DOTALL)
    
    # 5. Remove meta/title tags that leaked into body
    html = re.sub(r'<meta[^>]*>', '', html)
    html = re.sub(r'<title[^>]*>.*?</title>', '', html)
    
    # 6. Remove font/span/div/center tags (keep content)
    html = re.sub(r'</?font[^>]*>', '', html)
    html = re.sub(r'</?span[^>]*>', '', html)
    html = re.sub(r'</?div[^>]*>', '\n', html)
    html = re.sub(r'</?center[^>]*>', '\n', html)
    
    # 7. Remove table/thead/tbody/tr/td/th tags (table structure)
    html = re.sub(r'</?table[^>]*>', '\n', html)
    html = re.sub(r'</?thead[^>]*>', '', html)
    html = re.sub(r'</?tbody[^>]*>', '', html)
    html = re.sub(r'</?tr[^>]*>', '\n', html)
    html = re.sub(r'<td[^>]*>', '', html)
    html = re.sub(r'</td>', '', html)
    html = re.sub(r'<th[^>]*>', '', html)
    html = re.sub(r'</th>', '', html)
    
    # 8. Images: <img src="x" ...> → ![](x)
    html = re.sub(r'<img[^>]*src=["\']([^"\']+)["\'][^>]*>', r'![](\1)', html)
    
    # 9. Bold/strong
    html = re.sub(r'</?b>', '**', html)
    html = re.sub(r'</?strong>', '**', html)
    html = re.sub(r'\*\*\*\*', '', html)  # remove double bold
    
    # 10. Italic
    html = re.sub(r'</?i>', '*', html)
    html = re.sub(r'</?em>', '*', html)
    
    # 11. Paragraphs
    html = re.sub(r'<p[^>]*>', '\n\n', html)
    html = re.sub(r'</p>', '', html)
    
    # 12. Line breaks
    html = re.sub(r'<br\s*/?>', '\n', html)
    
    # 13. Links: <a href="x">text</a> → [text](x)
    html = re.sub(r'<a[^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', r'[\2](\1)', html)
    
    # 14. Headings
    for i in range(3, 0, -1):
        html = re.sub(f'<h{i}[^>]*>', '#' * i + ' ', html)
        html = re.sub(f'</h{i}>', '', html)
    
    # 15. Lists
    html = re.sub(r'<li[^>]*>', '- ', html)
    html = re.sub(r'</li>', '', html)
    
    # 16. Horizontal rules
    html = re.sub(r'<hr[^>]*>', '\n---\n', html)
    
    # 17. Remove remaining HTML tags
    html = re.sub(r'<[^>]+>', '', html)
    
    # 18. Decode HTML entities
    html = html.replace('&nbsp;', ' ').replace('&lt;', '<').replace('&gt;', '>')
    html = html.replace('&amp;', '&').replace('&quot;', '"').replace('&#39;', "'")
    html = html.replace('&#160;', ' ')
    
    # 19. Remove dapenti boilerplate patterns
    # Remove 免责申明 block (everything before 【1】)
    # Find the first numbered entry
    first_entry = re.search(r'【\d+】', html)
    if first_entry:
        # Keep only content from the first numbered entry onward
        before = html[:first_entry.start()]
        after = html[first_entry.start():]
        
        # But keep any images that appear before 【1】 (header images)
        header_imgs = re.findall(r'!\[.*?\]\([^)]+\)', before)
        
        html = after
        if header_imgs:
            html = '\n'.join(header_imgs) + '\n\n' + html
    
    # 20. Clean up whitespace
    # Remove trailing spaces from each line
    html = re.sub(r' +\n', '\n', html)
    html = re.sub(r' +$', '', html, flags=re.MULTILINE)
    # Remove leading spaces from each line (indentation)
    html = re.sub(r'^\s+', '', html, flags=re.MULTILINE)
    # Collapse multiple blank lines
    html = re.sub(r'\n{3,}', '\n\n', html)
    
    return html.strip()

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('Usage: html_to_md.py <input.json> <output.md>', file=sys.stderr)
        sys.exit(1)
    
    input_path = sys.argv[1]
    output_path = sys.argv[2]
    
    with open(input_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    title = data.get('title', '')
    html = data.get('html', '')
    
    md = html_to_md(html)
    
    # Prepend title
    if title:
        md = f'# {title}\n\n{md}'
    
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(md + '\n')
