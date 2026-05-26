package com.dpvr.dpagent.client;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Space;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MainActivity extends Activity {
    private static final String PREFS_NAME = "dpagent_android_client";
    private static final String KEY_COMPUTERS = "computers";
    private static final String KEY_SHARED_LINKS = "sharedLinks";
    private static final String SHARE_PATH_PREFIX = "/dpagent-share/";
    private static final Pattern IPV4 = Pattern.compile(
            "^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}"
                    + "(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$");
    private static final Pattern URL_CANDIDATE = Pattern.compile("https?://\\S+", Pattern.CASE_INSENSITIVE);

    private final List<ComputerEntry> computers = new ArrayList<>();
    private final List<SharedLinkEntry> sharedLinks = new ArrayList<>();
    private FrameLayout root;
    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        root = new FrameLayout(this);
        setContentView(root);
        loadComputers();
        loadSharedLinks();

        SharedLinkEntry incoming = consumeIncomingSharedLink(getIntent(), false);
        showList();
        if (incoming != null) {
            openWebView(incoming.url, incoming.url);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        SharedLinkEntry incoming = consumeIncomingSharedLink(intent, true);
        if (incoming != null) {
            openWebView(incoming.url, incoming.url);
            return;
        }
        showList();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        if (webView != null) {
            showList();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        destroyWebView();
        super.onDestroy();
    }

    private void showList() {
        destroyWebView();

        ScrollView scrollView = new ScrollView(this);
        scrollView.setFillViewport(true);
        scrollView.setBackgroundColor(color(11, 18, 32));

        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setPadding(dp(20), dp(24), dp(20), dp(24));
        scrollView.addView(page, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));

        page.addView(createHeader());
        if (!sharedLinks.isEmpty()) {
            page.addView(createSectionLabel("分享链接"));
            for (int i = 0; i < sharedLinks.size(); i++) {
                page.addView(createSharedLinkCard(i));
            }
        }

        if (!computers.isEmpty()) {
            page.addView(createSectionLabel("客户端"));
            for (int i = 0; i < computers.size(); i++) {
                page.addView(createComputerCard(i));
            }
        }

        if (sharedLinks.isEmpty() && computers.isEmpty()) {
            page.addView(createEmptyState());
        }

        root.removeAllViews();
        root.addView(scrollView);
    }

    private View createHeader() {
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.VERTICAL);

        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);

        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);

        TextView eyebrow = new TextView(this);
        eyebrow.setText("REMOTE WEB CONSOLE");
        eyebrow.setTextColor(color(125, 211, 252));
        eyebrow.setTextSize(12);
        eyebrow.setTypeface(Typeface.DEFAULT_BOLD);
        copy.addView(eyebrow);

        TextView title = new TextView(this);
        title.setText("DPAgent");
        title.setTextColor(Color.WHITE);
        title.setTextSize(34);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setPadding(0, dp(4), 0, 0);
        copy.addView(title);

        top.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

        Button add = accentButton("↗");
        add.setTextSize(26);
        add.setOnClickListener(v -> showAddMenu());
        top.addView(add, new LinearLayout.LayoutParams(dp(54), dp(54)));
        header.addView(top);

        TextView subtitle = new TextView(this);
        subtitle.setText("选择客户端直连，或打开别人发来的 DPAgent 分享链接。");
        subtitle.setTextColor(color(148, 163, 184));
        subtitle.setTextSize(15);
        subtitle.setPadding(0, dp(8), 0, dp(20));
        header.addView(subtitle);
        return header;
    }

    private void showAddMenu() {
        new AlertDialog.Builder(this)
                .setItems(new String[]{"添加分享链接", "添加客户端"}, (dialog, which) -> {
                    if (which == 0) {
                        addSharedLinkFromClipboard();
                    } else {
                        showEditDialog(-1);
                    }
                })
                .show();
    }

    private View createSectionLabel(String text) {
        TextView label = new TextView(this);
        label.setText(text);
        label.setTextColor(color(203, 213, 225));
        label.setTextSize(13);
        label.setTypeface(Typeface.DEFAULT_BOLD);
        label.setPadding(0, dp(2), 0, dp(8));
        return label;
    }

    private View createEmptyState() {
        LinearLayout empty = new LinearLayout(this);
        empty.setOrientation(LinearLayout.VERTICAL);
        empty.setGravity(Gravity.CENTER);
        empty.setPadding(dp(22), dp(42), dp(22), dp(42));
        empty.setBackground(rounded(color(15, 23, 42), dp(20), color(30, 41, 59), dp(1)));

        TextView mark = new TextView(this);
        mark.setText("DP");
        mark.setGravity(Gravity.CENTER);
        mark.setTextColor(color(15, 23, 42));
        mark.setTextSize(20);
        mark.setTypeface(Typeface.DEFAULT_BOLD);
        mark.setBackground(rounded(color(34, 211, 238), dp(18), Color.TRANSPARENT, 0));
        empty.addView(mark, new LinearLayout.LayoutParams(dp(64), dp(64)));

        TextView text = new TextView(this);
        text.setText("还没有内容。点右上角箭头添加分享链接或客户端。");
        text.setTextColor(color(203, 213, 225));
        text.setTextSize(15);
        text.setGravity(Gravity.CENTER);
        text.setPadding(0, dp(18), 0, 0);
        empty.addView(text);
        return empty;
    }

    private View createSharedLinkCard(int index) {
        SharedLinkEntry entry = sharedLinks.get(index);
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(16), dp(14), dp(16), dp(14));
        card.setBackground(rounded(color(236, 253, 245), dp(18), Color.TRANSPARENT, 0));

        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);

        TextView avatar = new TextView(this);
        avatar.setText("SH");
        avatar.setGravity(Gravity.CENTER);
        avatar.setTextColor(Color.WHITE);
        avatar.setTextSize(14);
        avatar.setTypeface(Typeface.DEFAULT_BOLD);
        avatar.setBackground(rounded(color(5, 150, 105), dp(14), Color.TRANSPARENT, 0));
        top.addView(avatar, new LinearLayout.LayoutParams(dp(46), dp(46)));

        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.setPadding(dp(12), 0, 0, 0);

        TextView name = new TextView(this);
        name.setText(entry.label);
        name.setTextColor(color(15, 23, 42));
        name.setTextSize(18);
        name.setTypeface(Typeface.DEFAULT_BOLD);
        copy.addView(name);

        TextView address = new TextView(this);
        address.setText(entry.url);
        address.setTextColor(color(71, 85, 105));
        address.setTextSize(13);
        address.setSingleLine(true);
        address.setEllipsize(TextUtils.TruncateAt.MIDDLE);
        address.setPadding(0, dp(3), 0, 0);
        copy.addView(address);

        top.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        card.addView(top);

        Space space = new Space(this);
        card.addView(space, new LinearLayout.LayoutParams(1, dp(14)));

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);

        Button open = primaryButton("打开");
        open.setOnClickListener(v -> openWebView(entry.url, entry.url));
        actions.addView(open, new LinearLayout.LayoutParams(0, dp(46), 1));

        Button delete = quietButton("删除");
        delete.setOnClickListener(v -> confirmDeleteSharedLink(index));
        LinearLayout.LayoutParams deleteParams = new LinearLayout.LayoutParams(dp(84), dp(46));
        deleteParams.setMargins(dp(10), 0, 0, 0);
        actions.addView(delete, deleteParams);

        card.addView(actions);

        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        params.setMargins(0, 0, 0, dp(14));
        card.setLayoutParams(params);
        return card;
    }

    private View createComputerCard(int index) {
        ComputerEntry entry = computers.get(index);
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(16), dp(14), dp(16), dp(14));
        card.setBackground(rounded(color(248, 250, 252), dp(18), Color.TRANSPARENT, 0));

        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);

        TextView avatar = new TextView(this);
        avatar.setText(initials(entry.name));
        avatar.setGravity(Gravity.CENTER);
        avatar.setTextColor(Color.WHITE);
        avatar.setTextSize(14);
        avatar.setTypeface(Typeface.DEFAULT_BOLD);
        avatar.setBackground(rounded(color(37, 99, 235), dp(14), Color.TRANSPARENT, 0));
        top.addView(avatar, new LinearLayout.LayoutParams(dp(46), dp(46)));

        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.setPadding(dp(12), 0, 0, 0);

        TextView name = new TextView(this);
        name.setText(entry.name);
        name.setTextColor(color(15, 23, 42));
        name.setTextSize(18);
        name.setTypeface(Typeface.DEFAULT_BOLD);
        copy.addView(name);

        TextView address = new TextView(this);
        address.setText(entry.ip + ":" + entry.port);
        address.setTextColor(color(71, 85, 105));
        address.setTextSize(14);
        address.setPadding(0, dp(3), 0, 0);
        copy.addView(address);

        top.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        card.addView(top);

        Space space = new Space(this);
        card.addView(space, new LinearLayout.LayoutParams(1, dp(14)));

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);

        Button open = primaryButton("打开");
        open.setOnClickListener(v -> openWebView(entry.toUrl()));
        actions.addView(open, new LinearLayout.LayoutParams(0, dp(46), 1));

        Button edit = quietButton("编辑");
        edit.setOnClickListener(v -> showEditDialog(index));
        LinearLayout.LayoutParams editParams = new LinearLayout.LayoutParams(dp(76), dp(46));
        editParams.setMargins(dp(10), 0, 0, 0);
        actions.addView(edit, editParams);

        Button delete = quietButton("删除");
        delete.setOnClickListener(v -> confirmDelete(index));
        LinearLayout.LayoutParams deleteParams = new LinearLayout.LayoutParams(dp(76), dp(46));
        deleteParams.setMargins(dp(8), 0, 0, 0);
        actions.addView(delete, deleteParams);

        card.addView(actions);

        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        params.setMargins(0, 0, 0, dp(14));
        card.setLayoutParams(params);
        return card;
    }

    private void addSharedLinkFromClipboard() {
        String clipboard = readClipboardText();
        String url = extractSharedLink(clipboard);
        if (url == null) {
            Toast.makeText(this, "剪贴板里没有可识别的 DPAgent 分享链接", Toast.LENGTH_SHORT).show();
            return;
        }
        SharedLinkEntry entry = addSharedLink(url);
        saveSharedLinks();
        showList();
        Toast.makeText(this, "已加入分享：" + entry.label, Toast.LENGTH_SHORT).show();
    }

    private String readClipboardText() {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard == null || !clipboard.hasPrimaryClip()) {
            return "";
        }
        ClipData clip = clipboard.getPrimaryClip();
        if (clip == null || clip.getItemCount() == 0) {
            return "";
        }
        CharSequence text = clip.getItemAt(0).coerceToText(this);
        return text == null ? "" : text.toString();
    }

    private SharedLinkEntry consumeIncomingSharedLink(Intent intent, boolean notify) {
        String incoming = extractIncomingText(intent);
        String url = extractSharedLink(incoming);
        if (url == null) {
            if (notify && incoming != null && !incoming.trim().isEmpty()) {
                Toast.makeText(this, "这不是 DPAgent 分享链接", Toast.LENGTH_SHORT).show();
            }
            return null;
        }
        SharedLinkEntry entry = addSharedLink(url);
        saveSharedLinks();
        if (notify) {
            Toast.makeText(this, "已打开分享：" + entry.label, Toast.LENGTH_SHORT).show();
        }
        return entry;
    }

    private String extractIncomingText(Intent intent) {
        if (intent == null) {
            return "";
        }
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action) && intent.getDataString() != null) {
            return intent.getDataString();
        }
        if (Intent.ACTION_SEND.equals(action)) {
            CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            if (text != null) {
                return text.toString();
            }
        }
        return "";
    }

    private SharedLinkEntry addSharedLink(String url) {
        String normalized = normalizeSharedLink(url);
        if (normalized == null) {
            throw new IllegalArgumentException("Invalid shared link");
        }
        for (SharedLinkEntry entry : sharedLinks) {
            if (entry.url.equals(normalized)) {
                return entry;
            }
        }
        SharedLinkEntry entry = new SharedLinkEntry(buildSharedLinkLabel(normalized), normalized);
        sharedLinks.add(0, entry);
        return entry;
    }

    private String extractSharedLink(String rawText) {
        if (rawText == null || rawText.trim().isEmpty()) {
            return null;
        }
        String direct = normalizeSharedLink(rawText.trim());
        if (direct != null) {
            return direct;
        }
        Matcher matcher = URL_CANDIDATE.matcher(rawText);
        while (matcher.find()) {
            String candidate = stripTrailingPunctuation(matcher.group());
            String normalized = normalizeSharedLink(candidate);
            if (normalized != null) {
                return normalized;
            }
        }
        return null;
    }

    private String normalizeSharedLink(String rawUrl) {
        if (rawUrl == null) {
            return null;
        }
        String cleaned = stripTrailingPunctuation(rawUrl.trim());
        Uri uri = Uri.parse(cleaned);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.US);
        String path = uri.getPath() == null ? "" : uri.getPath();
        if ((!"http".equals(scheme) && !"https".equals(scheme)) || uri.getHost() == null) {
            return null;
        }
        if (!path.startsWith(SHARE_PATH_PREFIX) || path.length() <= SHARE_PATH_PREFIX.length()) {
            return null;
        }
        return uri.toString();
    }

    private String stripTrailingPunctuation(String value) {
        String cleaned = value;
        while (cleaned.endsWith(".")
                || cleaned.endsWith(",")
                || cleaned.endsWith(")")
                || cleaned.endsWith("]")
                || cleaned.endsWith("}")
                || cleaned.endsWith("\"")
                || cleaned.endsWith("'")) {
            cleaned = cleaned.substring(0, cleaned.length() - 1);
        }
        return cleaned;
    }

    private String buildSharedLinkLabel(String url) {
        Uri uri = Uri.parse(url);
        String host = uri.getHost() == null ? "DPAgent" : uri.getHost();
        int port = uri.getPort();
        if (port > 0) {
            host += ":" + port;
        }
        return host + " 分享";
    }

    private void showEditDialog(int index) {
        boolean editing = index >= 0;
        ComputerEntry existing = editing ? computers.get(index) : null;

        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(dp(20), dp(6), dp(20), 0);

        EditText nameInput = input("名称，例如 办公室电脑", InputType.TYPE_CLASS_TEXT);
        nameInput.setText(editing ? existing.name : "");
        form.addView(nameInput);

        EditText ipInput = input("IP，例如 192.168.1.20", InputType.TYPE_CLASS_PHONE);
        ipInput.setText(editing ? existing.ip : "");
        form.addView(ipInput);

        EditText portInput = input("端口，例如 3000", InputType.TYPE_CLASS_NUMBER);
        portInput.setText(editing ? String.valueOf(existing.port) : "");
        form.addView(portInput);

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(editing ? "编辑客户端" : "新增客户端")
                .setView(form)
                .setNegativeButton("取消", null)
                .setPositiveButton("保存", null)
                .create();

        dialog.setOnShowListener(d -> {
            dialog.getButton(DialogInterface.BUTTON_POSITIVE).setOnClickListener(v -> {
                ComputerEntry next = readEntry(nameInput, ipInput, portInput);
                if (next == null) {
                    return;
                }
                if (editing) {
                    computers.set(index, next);
                } else {
                    computers.add(next);
                }
                saveComputers();
                hideKeyboard(portInput);
                dialog.dismiss();
                showList();
            });
            nameInput.requestFocus();
            Window window = dialog.getWindow();
            if (window != null) {
                window.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE);
            }
        });
        dialog.show();
    }

    private ComputerEntry readEntry(EditText nameInput, EditText ipInput, EditText portInput) {
        String name = nameInput.getText().toString().trim();
        String ip = ipInput.getText().toString().trim();
        String portText = portInput.getText().toString().trim();
        if (name.isEmpty()) {
            nameInput.setError("请输入名称");
            return null;
        }
        if (!IPV4.matcher(ip).matches()) {
            ipInput.setError("请输入正确的 IP");
            return null;
        }
        int port;
        try {
            port = Integer.parseInt(portText);
        } catch (NumberFormatException error) {
            portInput.setError("请输入端口");
            return null;
        }
        if (port < 1 || port > 65535) {
            portInput.setError("端口范围是 1-65535");
            return null;
        }
        return new ComputerEntry(name, ip, port);
    }

    private void confirmDelete(int index) {
        ComputerEntry entry = computers.get(index);
        new AlertDialog.Builder(this)
                .setTitle("删除客户端")
                .setMessage("确定删除 “" + entry.name + "”？")
                .setNegativeButton("取消", null)
                .setPositiveButton("删除", (dialog, which) -> {
                    computers.remove(index);
                    saveComputers();
                    showList();
                })
                .show();
    }

    private void confirmDeleteSharedLink(int index) {
        SharedLinkEntry entry = sharedLinks.get(index);
        new AlertDialog.Builder(this)
                .setTitle("删除分享链接")
                .setMessage("确定删除 “" + entry.label + "”？")
                .setNegativeButton("取消", null)
                .setPositiveButton("删除", (dialog, which) -> {
                    sharedLinks.remove(index);
                    saveSharedLinks();
                    showList();
                })
                .show();
    }

    private boolean removeSharedLink(String url) {
        String normalized = normalizeSharedLink(url);
        if (normalized == null) {
            return false;
        }
        for (int i = 0; i < sharedLinks.size(); i++) {
            if (sharedLinks.get(i).url.equals(normalized)) {
                sharedLinks.remove(i);
                saveSharedLinks();
                return true;
            }
        }
        return false;
    }

    private boolean isSharedLinkInvalidStatus(int statusCode) {
        return statusCode == 401 || statusCode == 403 || statusCode == 404 || statusCode == 410;
    }

    private void openWebView(String url) {
        openWebView(url, null);
    }

    private void openWebView(String url, String sharedLinkUrl) {
        destroyWebView();
        webView = new WebView(this);
        configureWebView(webView, sharedLinkUrl);
        root.removeAllViews();
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        webView.loadUrl(url);
    }

    private void configureWebView(WebView view, String sharedLinkUrl) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setBuiltInZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(view, true);

        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                view.loadUrl(request.getUrl().toString());
                return true;
            }

            @Override
            public void onReceivedHttpError(
                    WebView view,
                    WebResourceRequest request,
                    WebResourceResponse errorResponse) {
                super.onReceivedHttpError(view, request, errorResponse);
                if (sharedLinkUrl == null || !request.isForMainFrame() || errorResponse == null) {
                    return;
                }
                if (isSharedLinkInvalidStatus(errorResponse.getStatusCode())
                        && removeSharedLink(sharedLinkUrl)) {
                    Toast.makeText(MainActivity.this, "分享链接已失效，已从列表移除", Toast.LENGTH_SHORT).show();
                    showList();
                }
            }
        });

        view.setWebChromeClient(new WebChromeClient());
    }

    private void loadComputers() {
        computers.clear();
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String raw = prefs.getString(KEY_COMPUTERS, "[]");
        try {
            JSONArray array = new JSONArray(raw);
            for (int i = 0; i < array.length(); i++) {
                ComputerEntry entry = parseEntry(array.getJSONObject(i));
                if (entry != null) {
                    computers.add(entry);
                }
            }
        } catch (JSONException ignored) {
            computers.clear();
        }
    }

    private void loadSharedLinks() {
        sharedLinks.clear();
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String raw = prefs.getString(KEY_SHARED_LINKS, "[]");
        try {
            JSONArray array = new JSONArray(raw);
            for (int i = 0; i < array.length(); i++) {
                SharedLinkEntry entry = parseSharedLinkEntry(array.getJSONObject(i));
                if (entry != null) {
                    sharedLinks.add(entry);
                }
            }
        } catch (JSONException ignored) {
            sharedLinks.clear();
        }
    }

    private ComputerEntry parseEntry(JSONObject item) {
        String name = item.optString("name").trim();
        String ip = item.optString("ip").trim();
        int port = item.optInt("port", -1);

        if ((ip.isEmpty() || port < 1) && item.has("url")) {
            Uri uri = Uri.parse(item.optString("url"));
            ip = uri.getHost() == null ? "" : uri.getHost();
            port = uri.getPort();
        }
        if (!name.isEmpty() && IPV4.matcher(ip).matches() && port >= 1 && port <= 65535) {
            return new ComputerEntry(name, ip, port);
        }
        return null;
    }

    private SharedLinkEntry parseSharedLinkEntry(JSONObject item) {
        String normalized = normalizeSharedLink(item.optString("url"));
        if (normalized == null) {
            return null;
        }
        String label = item.optString("label").trim();
        if (label.isEmpty()) {
            label = buildSharedLinkLabel(normalized);
        }
        return new SharedLinkEntry(label, normalized);
    }

    private void saveComputers() {
        JSONArray array = new JSONArray();
        for (ComputerEntry entry : computers) {
            JSONObject item = new JSONObject();
            try {
                item.put("name", entry.name);
                item.put("ip", entry.ip);
                item.put("port", entry.port);
                array.put(item);
            } catch (JSONException ignored) {
                Toast.makeText(this, "保存配置失败", Toast.LENGTH_SHORT).show();
            }
        }
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .edit()
                .putString(KEY_COMPUTERS, array.toString())
                .apply();
    }

    private void saveSharedLinks() {
        JSONArray array = new JSONArray();
        for (SharedLinkEntry entry : sharedLinks) {
            JSONObject item = new JSONObject();
            try {
                item.put("label", entry.label);
                item.put("url", entry.url);
                array.put(item);
            } catch (JSONException ignored) {
                Toast.makeText(this, "保存分享链接失败", Toast.LENGTH_SHORT).show();
            }
        }
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .edit()
                .putString(KEY_SHARED_LINKS, array.toString())
                .apply();
    }

    private void destroyWebView() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
    }

    private EditText input(String hint, int inputType) {
        EditText editText = new EditText(this);
        editText.setHint(hint);
        editText.setSingleLine(true);
        editText.setInputType(inputType);
        editText.setTextSize(16);
        return editText;
    }

    private Button primaryButton(String text) {
        Button button = baseButton(text);
        button.setTextColor(Color.WHITE);
        button.setBackground(rounded(color(37, 99, 235), dp(14), Color.TRANSPARENT, 0));
        return button;
    }

    private Button accentButton(String text) {
        Button button = baseButton(text);
        button.setTextColor(color(15, 23, 42));
        button.setBackground(rounded(color(34, 211, 238), dp(18), Color.TRANSPARENT, 0));
        return button;
    }

    private Button quietButton(String text) {
        Button button = baseButton(text);
        button.setTextColor(color(30, 41, 59));
        button.setBackground(rounded(color(226, 232, 240), dp(14), Color.TRANSPARENT, 0));
        return button;
    }

    private Button baseButton(String text) {
        Button button = new Button(this);
        button.setText(text);
        button.setAllCaps(false);
        button.setTextSize(15);
        button.setTypeface(Typeface.DEFAULT_BOLD);
        return button;
    }

    private GradientDrawable rounded(int fill, int radius, int strokeColor, int strokeWidth) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fill);
        drawable.setCornerRadius(radius);
        if (strokeWidth > 0) {
            drawable.setStroke(strokeWidth, strokeColor);
        }
        return drawable;
    }

    private String initials(String name) {
        String trimmed = name.trim();
        if (trimmed.length() <= 2) {
            return trimmed;
        }
        return trimmed.substring(0, 2);
    }

    private int color(int red, int green, int blue) {
        return Color.rgb(red, green, blue);
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }

    private void hideKeyboard(View view) {
        InputMethodManager input = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (input != null) {
            input.hideSoftInputFromWindow(view.getWindowToken(), 0);
        }
    }

    private static class ComputerEntry {
        final String name;
        final String ip;
        final int port;

        ComputerEntry(String name, String ip, int port) {
            this.name = name;
            this.ip = ip;
            this.port = port;
        }

        String toUrl() {
            return "http://" + ip + ":" + port;
        }
    }

    private static class SharedLinkEntry {
        final String label;
        final String url;

        SharedLinkEntry(String label, String url) {
            this.label = label;
            this.url = url;
        }
    }
}
