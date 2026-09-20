const exportButton =
    document.getElementById(
        "exportButton"
    );

const exportStatus =
    document.getElementById(
        "exportStatus"
    );

const doneSound =
    document.getElementById(
        "doneSound"
    );

const progressWrap =
    document.getElementById(
        "progressWrap"
    );

const progressBar =
    document.getElementById(
        "progressBar"
    );

const progressTrack =
    document.getElementById(
        "progressTrack"
    );

const progressLabel =
    document.getElementById(
        "progressLabel"
    );

const progressPercent =
    document.getElementById(
        "progressPercent"
    );

let progressTimer = null;

// ---------------------------------------------------------
// Progress UI
// ---------------------------------------------------------

function updateProgress(
    percent,
    message
) {
    const parsedPercent =
        Number(percent);

    const safePercent =
        Math.max(
            0,
            Math.min(
                Number.isFinite(
                    parsedPercent
                )
                    ? parsedPercent
                    : 0,

                100
            )
        );

    if (progressBar) {
        progressBar.style.width =
            `${safePercent}%`;
    }

    if (progressPercent) {
        progressPercent.textContent =
            `${safePercent}%`;
    }

    if (progressTrack) {
        progressTrack.setAttribute(
            "aria-valuenow",
            String(
                safePercent
            )
        );
    }

    if (
        message &&
        progressLabel
    ) {
        progressLabel.textContent =
            message;
    }
}

// ---------------------------------------------------------
// Poll backend progress
// ---------------------------------------------------------

async function pollProgress() {
    try {
        const response =
            await fetch(
                "/export-progress",
                {
                    cache:
                        "no-store",
                }
            );

        if (
            response.status ===
            401
        ) {
            window.location.href =
                "/";

            return;
        }

        if (!response.ok) {
            return;
        }

        const data =
            await response.json();

        switch (
        data.state
        ) {
            case "idle":
                break;

            case "starting":
                updateProgress(
                    0,
                    "Counting WooCommerce pages... 🐾"
                );

                break;

            case "fetching": {
                const orderText =
                    data.totalOrders
                        ? ` • ${data.totalOrders} orders`
                        : "";

                updateProgress(
                    data.percent,

                    `Fetched ${data.completedPages}/${data.totalPages} pages${orderText}`
                );

                break;
            }

            case "done":
                updateProgress(
                    100,
                    "All pages fetched! ฅ^•ﻌ•^ฅ"
                );

                break;

            case "error":
                if (
                    progressLabel
                ) {
                    progressLabel.textContent =
                        "The export cat encountered a problem ฅ(•ㅅ•❀)ฅ";
                }

                break;

            default:
                break;
        }
    } catch (error) {
        console.warn(
            "Could not fetch export progress:",
            error
        );
    }
}

// ---------------------------------------------------------
// Start polling
// ---------------------------------------------------------

function startProgressPolling() {
    if (
        progressTimer
    ) {
        clearInterval(
            progressTimer
        );
    }

    if (progressWrap) {
        progressWrap.hidden =
            false;
    }

    updateProgress(
        0,
        "Waking up the export cats... 🐈‍⬛"
    );

    // Get the first update immediately.
    pollProgress();

    // Then continue polling.
    progressTimer =
        setInterval(
            pollProgress,
            500
        );
}

// ---------------------------------------------------------
// Stop polling
// ---------------------------------------------------------

function stopProgressPolling() {
    if (
        progressTimer
    ) {
        clearInterval(
            progressTimer
        );

        progressTimer = null;
    }
}

// ---------------------------------------------------------
// Reset status styling
// ---------------------------------------------------------

function resetStatus() {
    if (!exportStatus) {
        return;
    }

    exportStatus.classList.remove(
        "error",
        "success"
    );

    exportStatus.classList.add(
        "muted"
    );
}

// ---------------------------------------------------------
// Export
// ---------------------------------------------------------

if (exportButton) {
    exportButton.addEventListener(
        "click",

        async () => {
            exportButton.disabled =
                true;

            exportButton.textContent =
                "Exporting... 🐾";

            resetStatus();

            if (exportStatus) {
                exportStatus.textContent =
                    "Fetching WooCommerce orders...";
            }

            startProgressPolling();

            try {
                // -----------------------------------------
                // Start export
                // -----------------------------------------

                const response =
                    await fetch(
                        "/export",
                        {
                            cache:
                                "no-store",
                        }
                    );

                // -----------------------------------------
                // Authentication expired
                // -----------------------------------------

                if (
                    response.status ===
                    401
                ) {
                    window.location.href =
                        "/";

                    return;
                }

                // -----------------------------------------
                // Error response
                // -----------------------------------------

                if (!response.ok) {
                    let message =
                        "Export failed.";

                    try {
                        const data =
                            await response.json();

                        if (data.error) {
                            message =
                                data.error;
                        }
                    } catch {
                        // Response wasn't JSON.
                    }

                    throw new Error(
                        message
                    );
                }

                // -----------------------------------------
                // CSV blob
                // -----------------------------------------

                const blob =
                    await response.blob();

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

                if (
                    filenameMatch
                ) {
                    filename =
                        filenameMatch[1];
                }

                // -----------------------------------------
                // Download CSV
                // -----------------------------------------

                const downloadUrl =
                    URL.createObjectURL(
                        blob
                    );

                const link =
                    document.createElement(
                        "a"
                    );

                link.href =
                    downloadUrl;

                link.download =
                    filename;

                document.body.appendChild(
                    link
                );

                link.click();

                link.remove();

                URL.revokeObjectURL(
                    downloadUrl
                );

                // -----------------------------------------
                // Success progress UI
                // -----------------------------------------

                updateProgress(
                    100,
                    "Export complete! ฅ^•ﻌ•^ฅ"
                );

                // -----------------------------------------
                // Success status
                // -----------------------------------------

                exportButton.textContent =
                    "Export Complete ✓";

                if (exportStatus) {
                    exportStatus.textContent =
                        `Downloaded ${filename}`;

                    exportStatus.classList.remove(
                        "muted",
                        "error"
                    );

                    exportStatus.classList.add(
                        "success"
                    );
                }

                // -----------------------------------------
                // Completion sound
                // -----------------------------------------

                if (doneSound) {
                    doneSound.currentTime =
                        0;

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
                console.error(
                    error
                );

                exportButton.textContent =
                    "Export Failed";

                if (exportStatus) {
                    exportStatus.textContent =
                        error.message ||
                        "Something went wrong.";

                    exportStatus.classList.remove(
                        "muted",
                        "success"
                    );

                    exportStatus.classList.add(
                        "error"
                    );
                }

                if (
                    progressLabel
                ) {
                    progressLabel.textContent =
                        "The export cat encountered a problem ฅ(•ㅅ•❀)ฅ";
                }
            } finally {
                stopProgressPolling();

                exportButton.disabled =
                    false;
            }
        }
    );
}