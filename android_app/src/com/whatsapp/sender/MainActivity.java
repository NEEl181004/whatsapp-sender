package com.whatsapp.sender;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.ContactsContract;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONArray;
import org.json.JSONObject;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.util.HashSet;

public class MainActivity extends Activity {

    private static final String PREFS_NAME = "WhatsAppSenderPrefs";
    private static final String KEY_SERVER_URL = "server_url";
    private static final String DEFAULT_SERVER_URL = "https://whatsapp-sender-hx4d.onrender.com";
    private static final int FILE_CHOOSER_REQUEST_CODE = 1001;
    private static final int CONTACTS_PERMISSION_CODE = 2002;

    private WebView webView;
    private ScrollView connectionDialog;
    private EditText etServerUrl;
    private TextView tvStatusMsg;
    private Button btnConnect;
    private Button btnAutoDetect;
    private ImageButton btnToggleSettings;

    private ValueCallback<Uri[]> uploadMessageCallback;
    private SharedPreferences prefs;
    private Handler mainHandler = new Handler(Looper.getMainLooper());
    private boolean isErrorState = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);

        webView = (WebView) findViewById(R.id.webView);
        connectionDialog = (ScrollView) findViewById(R.id.connectionDialog);
        etServerUrl = (EditText) findViewById(R.id.etServerUrl);
        tvStatusMsg = (TextView) findViewById(R.id.tvStatusMsg);
        btnConnect = (Button) findViewById(R.id.btnConnect);
        btnAutoDetect = (Button) findViewById(R.id.btnAutoDetect);
        btnToggleSettings = (ImageButton) findViewById(R.id.btnToggleSettings);

        setupWebView();
        setupControls();
        requestAppPermissions();

        String currentUrl = prefs.getString(KEY_SERVER_URL, DEFAULT_SERVER_URL);
        // Automatically migrate to live cloud Render URL if previously pointing to a local IP
        if (currentUrl.contains("172.") || currentUrl.contains("192.168.") || currentUrl.contains("localhost")) {
            currentUrl = DEFAULT_SERVER_URL;
            prefs.edit().putString(KEY_SERVER_URL, currentUrl).apply();
        }
        etServerUrl.setText(currentUrl);
        loadServerUrl(currentUrl);
    }

    private void setupWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);

        // Native bridge for phone contacts access
        webView.addJavascriptInterface(new WebAppInterface(this), "AndroidNative");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                isErrorState = false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (!isErrorState) {
                    connectionDialog.setVisibility(View.GONE);
                }
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                super.onReceivedError(view, errorCode, description, failingUrl);
                handleConnectionFailure(failingUrl, description);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request.isForMainFrame()) {
                    handleConnectionFailure(request.getUrl().toString(), "Connection Timed Out / Network Unreachable");
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (uploadMessageCallback != null) {
                    uploadMessageCallback.onReceiveValue(null);
                }
                uploadMessageCallback = filePathCallback;

                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);

                try {
                    startActivityForResult(Intent.createChooser(intent, "Select Contact File or Media"), FILE_CHOOSER_REQUEST_CODE);
                } catch (Exception e) {
                    uploadMessageCallback = null;
                    Toast.makeText(MainActivity.this, "Cannot open file picker", Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }
        });
    }

    private void setupControls() {
        btnConnect.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                String inputUrl = etServerUrl.getText().toString().trim();
                if (!inputUrl.startsWith("http://") && !inputUrl.startsWith("https://")) {
                    if (inputUrl.contains("onrender.com") || inputUrl.contains("railway.app") || inputUrl.contains(".com") || inputUrl.contains(".app") || inputUrl.contains(".io")) {
                        inputUrl = "https://" + inputUrl;
                    } else {
                        inputUrl = "http://" + inputUrl;
                    }
                }
                // Only append :3000 if it's not https and no port was specified
                if (!inputUrl.startsWith("https://") && !inputUrl.matches(".*:\\d+.*")) {
                    inputUrl = inputUrl + ":3000";
                }
                prefs.edit().putString(KEY_SERVER_URL, inputUrl).apply();
                connectionDialog.setVisibility(View.GONE);
                loadServerUrl(inputUrl);
            }
        });

        btnAutoDetect.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startAutoDiscovery();
            }
        });

        btnToggleSettings.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (connectionDialog.getVisibility() == View.VISIBLE) {
                    connectionDialog.setVisibility(View.GONE);
                } else {
                    String currentUrl = prefs.getString(KEY_SERVER_URL, DEFAULT_SERVER_URL);
                    etServerUrl.setText(currentUrl);
                    tvStatusMsg.setText("Enter or change your PC's IP address below:");
                    connectionDialog.setVisibility(View.VISIBLE);
                }
            }
        });
    }

    private void handleConnectionFailure(String failingUrl, String details) {
        isErrorState = true;
        // Load blank page to avoid standard white Android error page
        webView.loadUrl("about:blank");
        tvStatusMsg.setText("Could not reach " + failingUrl + "\n(" + details + ")\n\nPlease verify your PC IP address below:");
        connectionDialog.setVisibility(View.VISIBLE);
    }

    private void loadServerUrl(String url) {
        isErrorState = false;
        connectionDialog.setVisibility(View.GONE);
        webView.loadUrl(url);
    }

    private void startAutoDiscovery() {
        btnAutoDetect.setEnabled(false);
        btnAutoDetect.setText("Searching PC...");
        tvStatusMsg.setText("Broadcasting on Wi-Fi to find WhatsApp PC Server...");

        new Thread(new Runnable() {
            @Override
            public void run() {
                DatagramSocket socket = null;
                boolean found = false;
                String discoveredUrl = null;

                try {
                    socket = new DatagramSocket();
                    socket.setBroadcast(true);
                    socket.setSoTimeout(2500);

                    byte[] sendData = "DISCOVER_WHATSAPP_SENDER".getBytes("UTF-8");
                    DatagramPacket sendPacket = new DatagramPacket(
                        sendData,
                        sendData.length,
                        InetAddress.getByName("255.255.255.255"),
                        3001
                    );
                    socket.send(sendPacket);

                    byte[] recvBuf = new byte[512];
                    DatagramPacket recvPacket = new DatagramPacket(recvBuf, recvBuf.length);
                    socket.receive(recvPacket);

                    String response = new String(recvPacket.getData(), 0, recvPacket.getLength(), "UTF-8");
                    if (response.startsWith("WHATSAPP_SENDER_OFFER:")) {
                        String[] parts = response.split(":");
                        if (parts.length >= 3) {
                            String ip = parts[1];
                            String port = parts[2];
                            discoveredUrl = "http://" + ip + ":" + port;
                            found = true;
                        }
                    }
                } catch (Exception e) {
                    // Timeout or error
                } finally {
                    if (socket != null && !socket.isClosed()) {
                        socket.close();
                    }
                }

                final boolean isFound = found;
                final String finalUrl = discoveredUrl;

                mainHandler.post(new Runnable() {
                    @Override
                    public void run() {
                        btnAutoDetect.setEnabled(true);
                        btnAutoDetect.setText("Auto-Detect PC");

                        if (isFound && finalUrl != null) {
                            etServerUrl.setText(finalUrl);
                            Toast.makeText(MainActivity.this, "Found PC Server at " + finalUrl, Toast.LENGTH_SHORT).show();
                            prefs.edit().putString(KEY_SERVER_URL, finalUrl).apply();
                            connectionDialog.setVisibility(View.GONE);
                            loadServerUrl(finalUrl);
                        } else {
                            tvStatusMsg.setText("Could not auto-detect. Please check your PC IP in WhatsApp-Sender on PC and type it below:");
                            Toast.makeText(MainActivity.this, "Auto-detect timed out. Please enter PC IP manually.", Toast.LENGTH_LONG).show();
                        }
                    }
                });
            }
        }).start();
    }

    private void requestAppPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            String[] permissions = new String[]{
                "android.permission.READ_EXTERNAL_STORAGE",
                "android.permission.WRITE_EXTERNAL_STORAGE",
                "android.permission.READ_CONTACTS"
            };
            for (String p : permissions) {
                if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(permissions, 2001);
                    break;
                }
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST_CODE) {
            if (uploadMessageCallback == null) return;

            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{ data.getData() };
                }
            }
            uploadMessageCallback.onReceiveValue(results);
            uploadMessageCallback = null;
        } else {
            super.onActivityResult(requestCode, resultCode, data);
        }
    }

    @Override
    public void onBackPressed() {
        if (connectionDialog.getVisibility() == View.VISIBLE) {
            connectionDialog.setVisibility(View.GONE);
        } else if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    /**
     * JavaScript Bridge providing direct access to Phone Contacts
     */
    public class WebAppInterface {
        Context mContext;

        WebAppInterface(Context c) {
            mContext = c;
        }

        @JavascriptInterface
        public boolean isAndroidApp() {
            return true;
        }

        @JavascriptInterface
        public String getDeviceId() {
            String deviceId = prefs.getString("wa_permanent_device_id", null);
            if (deviceId == null) {
                String androidId = android.provider.Settings.Secure.getString(getContentResolver(), android.provider.Settings.Secure.ANDROID_ID);
                if (androidId != null && !androidId.trim().isEmpty() && !androidId.equals("9774d56d682e549c")) {
                    deviceId = "apk_" + androidId;
                } else {
                    deviceId = "apk_" + java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 16);
                }
                prefs.edit().putString("wa_permanent_device_id", deviceId).apply();
            }
            return deviceId;
        }

        @JavascriptInterface
        public String getDeviceContacts() {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                if (checkSelfPermission("android.permission.READ_CONTACTS") != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{ "android.permission.READ_CONTACTS" }, CONTACTS_PERMISSION_CODE);
                    return "PERMISSION_REQUIRED";
                }
            }

            JSONArray array = new JSONArray();
            ContentResolver cr = getContentResolver();
            Cursor cursor = null;

            try {
                cursor = cr.query(
                    ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                    new String[]{
                        ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                        ContactsContract.CommonDataKinds.Phone.NUMBER
                    },
                    null,
                    null,
                    ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " ASC"
                );

                if (cursor != null) {
                    int nameIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME);
                    int numIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER);
                    HashSet<String> seenDigits = new HashSet<String>();

                    while (cursor.moveToNext()) {
                        String name = cursor.getString(nameIdx);
                        String phone = cursor.getString(numIdx);

                        if (phone != null && !phone.trim().isEmpty()) {
                            String digits = phone.replaceAll("[^0-9]", "");
                            if (digits.length() >= 7 && !seenDigits.contains(digits)) {
                                seenDigits.add(digits);
                                JSONObject obj = new JSONObject();
                                obj.put("name", name != null && !name.trim().isEmpty() ? name : "Contact");
                                obj.put("phone", phone);
                                array.put(obj);
                            }
                        }
                    }
                }
            } catch (Exception e) {
                // Return empty on query exception
            } finally {
                if (cursor != null) {
                    cursor.close();
                }
            }

            return array.toString();
        }
    }
}
