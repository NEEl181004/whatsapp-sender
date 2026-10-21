using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace WhatsAppDispatcher
{
    public class Program : Form
    {
        private static Process nodeProcess = null;
        private static int port = 3000;
        private Label lblStatus;
        private Label lblLocalUrl;
        private Label lblPhoneUrl;
        private Button btnOpenBrowser;
        private Button btnCopyPhoneUrl;
        private Button btnRestart;
        private Button btnExit;
        private NotifyIcon trayIcon;
        private ContextMenuStrip trayMenu;
        private string localIp = "127.0.0.1";

        [STAThread]
        public static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new Program());
        }

        public Program()
        {
            this.Text = "WhatsApp Video & Contact Dispatcher";
            this.Size = new Size(520, 360);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.BackColor = Color.FromArgb(17, 24, 39);
            this.ForeColor = Color.White;

            localIp = GetLocalIPv4();

            BuildUI();
            SetupTray();

            this.FormClosing += (s, e) =>
            {
                StopNodeProcess();
                if (trayIcon != null)
                {
                    trayIcon.Visible = false;
                    trayIcon.Dispose();
                }
            };

            // Start server asynchronously
            ThreadPool.QueueUserWorkItem((state) =>
            {
                KillPortProcess(port);
                StartNodeServer();
                Thread.Sleep(1800);
                LaunchBrowser();
            });
        }

        private void BuildUI()
        {
            // Title Header
            Label lblTitle = new Label();
            lblTitle.Text = "WhatsApp Video & Contact Dispatcher";
            lblTitle.Font = new Font("Segoe UI", 13, FontStyle.Bold);
            lblTitle.ForeColor = Color.FromArgb(37, 211, 102);
            lblTitle.Location = new Point(24, 18);
            lblTitle.AutoSize = true;
            this.Controls.Add(lblTitle);

            // Subtitle
            Label lblSub = new Label();
            lblSub.Text = "Standalone Desktop Engine - Port & Background Manager";
            lblSub.Font = new Font("Segoe UI", 8.5f, FontStyle.Regular);
            lblSub.ForeColor = Color.FromArgb(156, 163, 175);
            lblSub.Location = new Point(26, 46);
            lblSub.AutoSize = true;
            this.Controls.Add(lblSub);

            // Status Card
            Panel card = new Panel();
            card.Location = new Point(24, 80);
            card.Size = new Size(456, 140);
            card.BackColor = Color.FromArgb(31, 41, 55);
            this.Controls.Add(card);

            lblStatus = new Label();
            lblStatus.Text = "● Starting WhatsApp Server Engine...";
            lblStatus.Font = new Font("Segoe UI", 10, FontStyle.Bold);
            lblStatus.ForeColor = Color.FromArgb(250, 204, 21);
            lblStatus.Location = new Point(16, 14);
            lblStatus.AutoSize = true;
            card.Controls.Add(lblStatus);

            lblLocalUrl = new Label();
            lblLocalUrl.Text = "Local Desktop URL: http://localhost:3000";
            lblLocalUrl.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
            lblLocalUrl.ForeColor = Color.FromArgb(229, 231, 235);
            lblLocalUrl.Location = new Point(16, 48);
            lblLocalUrl.AutoSize = true;
            card.Controls.Add(lblLocalUrl);

            string effectivePhoneUrl = (!string.IsNullOrEmpty(localIp) && localIp != "127.0.0.1" && localIp != "localhost" && (localIp.StartsWith("192.168.") || localIp.StartsWith("10.") || localIp.StartsWith("172.")))
                ? "http://" + localIp + ":3000"
                : "https://whatsapp-sender-hx4d.onrender.com";

            lblPhoneUrl = new Label();
            lblPhoneUrl.Text = "Mobile Phone URL:  " + effectivePhoneUrl;
            lblPhoneUrl.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
            lblPhoneUrl.ForeColor = Color.FromArgb(74, 222, 128);
            lblPhoneUrl.Location = new Point(16, 80);
            lblPhoneUrl.AutoSize = true;
            card.Controls.Add(lblPhoneUrl);

            Label lblHint = new Label();
            lblHint.Text = "Open this link on any phone (Android APK or Mobile Browser) to control WhatsApp Sender.";
            lblHint.Font = new Font("Segoe UI", 7.5f, FontStyle.Italic);
            lblHint.ForeColor = Color.FromArgb(156, 163, 175);
            lblHint.Location = new Point(16, 108);
            lblHint.AutoSize = true;
            card.Controls.Add(lblHint);

            // Action Buttons
            btnOpenBrowser = new Button();
            btnOpenBrowser.Text = "🌐 Open in Browser";
            btnOpenBrowser.Location = new Point(24, 236);
            btnOpenBrowser.Size = new Size(136, 36);
            btnOpenBrowser.BackColor = Color.FromArgb(37, 211, 102);
            btnOpenBrowser.ForeColor = Color.Black;
            btnOpenBrowser.Font = new Font("Segoe UI", 9, FontStyle.Bold);
            btnOpenBrowser.FlatStyle = FlatStyle.Flat;
            btnOpenBrowser.FlatAppearance.BorderSize = 0;
            btnOpenBrowser.Click += (s, e) => LaunchBrowser();
            this.Controls.Add(btnOpenBrowser);

            btnCopyPhoneUrl = new Button();
            btnCopyPhoneUrl.Text = "📱 Copy Phone URL";
            btnCopyPhoneUrl.Location = new Point(170, 236);
            btnCopyPhoneUrl.Size = new Size(136, 36);
            btnCopyPhoneUrl.BackColor = Color.FromArgb(55, 65, 81);
            btnCopyPhoneUrl.ForeColor = Color.White;
            btnCopyPhoneUrl.Font = new Font("Segoe UI", 9, FontStyle.Regular);
            btnCopyPhoneUrl.FlatStyle = FlatStyle.Flat;
            btnCopyPhoneUrl.FlatAppearance.BorderSize = 0;
            btnCopyPhoneUrl.Click += (s, e) =>
            {
                Clipboard.SetText(effectivePhoneUrl);
                btnCopyPhoneUrl.Text = "✔ Copied!";
                System.Windows.Forms.Timer t = new System.Windows.Forms.Timer();
                t.Interval = 2000;
                t.Tick += (ts, te) => { btnCopyPhoneUrl.Text = "📱 Copy Phone URL"; t.Stop(); t.Dispose(); };
                t.Start();
            };
            this.Controls.Add(btnCopyPhoneUrl);

            btnRestart = new Button();
            btnRestart.Text = "🔄 Restart Engine";
            btnRestart.Location = new Point(316, 236);
            btnRestart.Size = new Size(130, 36);
            btnRestart.BackColor = Color.FromArgb(55, 65, 81);
            btnRestart.ForeColor = Color.White;
            btnRestart.Font = new Font("Segoe UI", 9, FontStyle.Regular);
            btnRestart.FlatStyle = FlatStyle.Flat;
            btnRestart.FlatAppearance.BorderSize = 0;
            btnRestart.Click += (s, e) =>
            {
                btnRestart.Enabled = false;
                btnRestart.Text = "Restarting...";
                ThreadPool.QueueUserWorkItem((state) =>
                {
                    StopNodeProcess();
                    KillPortProcess(port);
                    Thread.Sleep(500);
                    StartNodeServer();
                    this.Invoke((MethodInvoker)delegate
                    {
                        btnRestart.Enabled = true;
                        btnRestart.Text = "🔄 Restart Engine";
                    });
                });
            };
            this.Controls.Add(btnRestart);

            btnExit = new Button();
            btnExit.Text = "✕ Stop & Exit";
            btnExit.Location = new Point(24, 282);
            btnExit.Size = new Size(422, 28);
            btnExit.BackColor = Color.FromArgb(31, 41, 55);
            btnExit.ForeColor = Color.FromArgb(239, 68, 68);
            btnExit.Font = new Font("Segoe UI", 8.5f, FontStyle.Regular);
            btnExit.FlatStyle = FlatStyle.Flat;
            btnExit.FlatAppearance.BorderColor = Color.FromArgb(75, 85, 99);
            btnExit.Click += (s, e) => this.Close();
            this.Controls.Add(btnExit);
        }

        private void SetupTray()
        {
            trayMenu = new ContextMenuStrip();
            trayMenu.Items.Add("Open in Browser", null, (s, e) => LaunchBrowser());
            trayMenu.Items.Add("Show App Window", null, (s, e) => { this.Show(); this.WindowState = FormWindowState.Normal; });
            trayMenu.Items.Add("-");
            trayMenu.Items.Add("Stop & Exit", null, (s, e) => this.Close());

            trayIcon = new NotifyIcon();
            trayIcon.Text = "WhatsApp Dispatcher";
            trayIcon.Icon = SystemIcons.Application;
            trayIcon.ContextMenuStrip = trayMenu;
            trayIcon.Visible = true;
            trayIcon.DoubleClick += (s, e) => { this.Show(); this.WindowState = FormWindowState.Normal; };
        }

        private void StartNodeServer()
        {
            try
            {
                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                string scriptPath = Path.Combine(baseDir, "server.js");

                if (!File.Exists(scriptPath))
                {
                    UpdateStatus("✖ Error: server.js not found in directory", Color.FromArgb(239, 68, 68));
                    return;
                }

                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = "node.exe";
                psi.Arguments = "\"" + scriptPath + "\"";
                psi.WorkingDirectory = baseDir;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;

                nodeProcess = Process.Start(psi);

                UpdateStatus("● Server Online - Running on Port 3000", Color.FromArgb(37, 211, 102));
            }
            catch (Exception ex)
            {
                UpdateStatus("✖ Error launching Node: " + ex.Message, Color.FromArgb(239, 68, 68));
            }
        }

        private void StopNodeProcess()
        {
            try
            {
                if (nodeProcess != null && !nodeProcess.HasExited)
                {
                    nodeProcess.Kill();
                    nodeProcess.WaitForExit(2000);
                    nodeProcess = null;
                }
            }
            catch { }
        }

        private void KillPortProcess(int targetPort)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = "netstat.exe";
                psi.Arguments = "-ano";
                psi.RedirectStandardOutput = true;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;

                using (Process p = Process.Start(psi))
                {
                    string output = p.StandardOutput.ReadToEnd();
                    p.WaitForExit();

                    string pattern = @":(" + targetPort + @")\s+.*\s+LISTENING\s+(\d+)";
                    foreach (Match match in Regex.Matches(output, pattern, RegexOptions.IgnoreCase))
                    {
                        if (match.Groups.Count >= 3)
                        {
                            int pid = int.Parse(match.Groups[2].Value);
                            if (pid > 0 && pid != Process.GetCurrentProcess().Id)
                            {
                                try
                                {
                                    Process procToKill = Process.GetProcessById(pid);
                                    procToKill.Kill();
                                    procToKill.WaitForExit(1000);
                                }
                                catch { }
                            }
                        }
                    }
                }
            }
            catch { }
        }

        private void LaunchBrowser()
        {
            try
            {
                Process.Start(new ProcessStartInfo("http://localhost:" + port) { UseShellExecute = true });
            }
            catch { }
        }

        private void UpdateStatus(string text, Color color)
        {
            if (this.InvokeRequired)
            {
                this.BeginInvoke((MethodInvoker)delegate { UpdateStatus(text, color); });
                return;
            }
            lblStatus.Text = text;
            lblStatus.ForeColor = color;
        }

        private string GetLocalIPv4()
        {
            try
            {
                string fallbackIp = null;
                foreach (var netInterface in System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces())
                {
                    if (netInterface.OperationalStatus == System.Net.NetworkInformation.OperationalStatus.Up)
                    {
                        string name = netInterface.Name.ToLower();
                        if (name.Contains("vethernet") || name.Contains("virtual") || name.Contains("wsl") || name.Contains("loopback") || name.Contains("ethernet 3"))
                            continue;

                        bool isWifi = name.Contains("wi-fi") || name.Contains("wireless") || name.Contains("wlan");

                        var ipProps = netInterface.GetIPProperties();
                        foreach (var addr in ipProps.UnicastAddresses)
                        {
                            if (addr.Address.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(addr.Address))
                            {
                                string s = addr.Address.ToString();
                                if (s.StartsWith("192.168.") || s.StartsWith("10.") || s.StartsWith("172."))
                                {
                                    if (isWifi)
                                        return s;
                                    if (fallbackIp == null)
                                        fallbackIp = s;
                                }
                            }
                        }
                    }
                }
                if (fallbackIp != null) return fallbackIp;
            }
            catch { }
            return "127.0.0.1";
        }
    }
}
