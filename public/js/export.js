const exportButton =
    document.getElementById("exportButton");

const exportStatus =
    document.getElementById("exportStatus");

const doneSound =
    document.getElementById("doneSound");

if (exportButton) {
    exportButton.addEventListener(
        "click",
        async () => {
            exportButton.disabled = true;
            exportButton.textContent = "Exporting...";

            exportStatus.textContent =
                "Fetching WooCommerce orders...";

            try {
                const response = await fetch("/export");

                if (response.status === 401) {
                    window.location.href = "/";
                    return;
                }

                if (!response.ok) {
                    let message = "Export failed.";

                    try {
                        const data = await response.json();

                        if (data.error) {
                            message = data.error;
                        }
                    } catch {
                        // Response wasn't JSON.
                    }

                    throw new Error(message);
                }

                const blob = await response.blob();

                // -----------------------------------------
                // Get filename from response header
                // -----------------------------------------

                const disposition =
                    response.headers.get(
                        "Content-Disposition"
                    );

                let filename =
                    "woocommerce-orders.csv";

                const filenameMatch =
                    disposition?.match(
                        /filename="([^"]+)"/
                    );

                if (filenameMatch) {
                    filename = filenameMatch[1];
                }

                // -----------------------------------------
                // Download CSV
                // -----------------------------------------

                const downloadUrl =
                    URL.createObjectURL(blob);

                const link =
                    document.createElement("a");

                link.href = downloadUrl;
                link.download = filename;

                document.body.appendChild(link);

                link.click();
                link.remove();

                URL.revokeObjectURL(downloadUrl);

                // -----------------------------------------
                // Success UI
                // -----------------------------------------

                exportButton.textContent =
                    "Export Complete ✓";

                exportStatus.textContent =
                    `Downloaded ${filename}`;

                exportStatus.classList.remove("muted");
                exportStatus.classList.add("success");

                // -----------------------------------------
                // Completion sound
                // -----------------------------------------

                if (doneSound) {
                    doneSound.currentTime = 0;

                    try {
                        await doneSound.play();
                    } catch (error) {
                        console.warn(
                            "Completion sound could not play:",
                            error
                        );
                    }
                }
            } catch (error) {
                console.error(error);

                exportButton.textContent =
                    "Export Failed";

                exportStatus.textContent =
                    error.message ||
                    "Something went wrong.";

                exportStatus.classList.remove(
                    "muted",
                    "success"
                );

                exportStatus.classList.add("error");
            } finally {
                exportButton.disabled = false;
            }
        }
    );
}