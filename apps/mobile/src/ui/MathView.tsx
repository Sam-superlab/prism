import React, { useMemo, useState } from 'react';
import { WebView } from 'react-native-webview';
import { renderToString } from 'katex';
import { katexCss } from './katex-css';
import { useWindowDimensions } from 'react-native';
import { useAppearance } from './theme';
const escape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function MathView({ content }: { content: string }) {
  const { colors, font, reduceMotion } = useAppearance();
  const { fontScale } = useWindowDimensions();
  const [height, setHeight] = useState(80);
  const html = useMemo(() => {
    const parts = content.split(/(\$\$[\s\S]*?\$\$|\$[^$\n]+?\$)/g);
    const body = parts
      .map((part) =>
        part.startsWith('$$')
          ? renderToString(part.slice(2, -2), { displayMode: true, throwOnError: false, trust: false })
          : part.startsWith('$')
            ? renderToString(part.slice(1, -1), { throwOnError: false, trust: false })
            : escape(part).replace(/\n/g, '<br>'),
      )
      .join('');
    return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${katexCss}body{margin:0;padding:4px 0;background:${colors.paper};color:${colors.ink};font:${font(16) * fontScale}px/1.7 -apple-system,sans-serif;overflow-wrap:anywhere}${reduceMotion ? '*{animation:none!important;transition:none!important;scroll-behavior:auto!important}' : ''}.katex-display{overflow-x:auto;overflow-y:hidden}</style></head><body>${body}<script>function size(){window.ReactNativeWebView.postMessage(String(document.documentElement.scrollHeight))}window.onload=size;document.fonts.ready.then(size);setTimeout(size,200)</script></body></html>`;
  }, [content, colors, font, fontScale, reduceMotion]);
  return (
    <WebView
      accessibilityLabel={content}
      originWhitelist={['about:blank']}
      source={{ html }}
      style={{ height, backgroundColor: colors.paper }}
      scrollEnabled={false}
      onMessage={(event) => {
        const next = Number(event.nativeEvent.data);
        if (next > 0 && next < 100000) setHeight(next + 8);
      }}
      onShouldStartLoadWithRequest={(request) => request.url === 'about:blank'}
    />
  );
}
