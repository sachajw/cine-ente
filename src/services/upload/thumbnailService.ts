import { FILE_TYPE } from 'services/fileService';
import { CustomError, errorWithContext } from 'utils/common/errorUtil';
import { logError } from 'utils/sentry';
import { BLACK_THUMBNAIL_BASE64 } from '../../../public/images/black-thumbnail-b64';
import FFmpegService from 'services/ffmpegService';

const THUMBNAIL_HEIGHT = 720;
const MIN_COMPRESSION_PERCENTAGE_SIZE_DIFF = 10;
export const MAX_THUMBNAIL_SIZE = 50 * 1024;

const WAIT_TIME_THUMBNAIL_GENERATION = 10 * 1000;

export async function generateThumbnail(
    worker,
    file: globalThis.File,
    fileType: FILE_TYPE,
    isHEIC: boolean
): Promise<{ thumbnail: Uint8Array; hasStaticThumbnail: boolean }> {
    try {
        let hasStaticThumbnail = false;
        let canvas = document.createElement('canvas');
        let thumbnail: Uint8Array;
        try {
            if (fileType === FILE_TYPE.IMAGE) {
                canvas = await generateImageThumbnail(worker, file, isHEIC);
            } else {
                try {
                    const thumb = await FFmpegService.generateThumbnail(file);
                    const dummyImageFile = new File([thumb], file.name);
                    canvas = await generateImageThumbnail(
                        worker,
                        dummyImageFile,
                        isHEIC
                    );
                } catch (e) {
                    canvas = await generateVideoThumbnail(file);
                }
            }
            const thumbnailBlob = await thumbnailCanvasToBlob(canvas);
            thumbnail = await worker.getUint8ArrayView(thumbnailBlob);
            if (thumbnail.length === 0) {
                throw Error('EMPTY THUMBNAIL');
            }
        } catch (e) {
            logError(e, 'uploading static thumbnail');
            thumbnail = Uint8Array.from(atob(BLACK_THUMBNAIL_BASE64), (c) =>
                c.charCodeAt(0)
            );
            hasStaticThumbnail = true;
        }
        return { thumbnail, hasStaticThumbnail };
    } catch (e) {
        logError(e, 'Error generating static thumbnail');
        throw e;
    }
}

export async function generateImageThumbnail(
    worker,
    file: globalThis.File,
    isHEIC: boolean
) {
    const canvas = document.createElement('canvas');
    const canvasCTX = canvas.getContext('2d');

    let imageURL = null;
    let timeout = null;

    if (isHEIC) {
        file = new globalThis.File(
            [await worker.convertHEIC2JPEG(file)],
            null,
            null
        );
    }
    let image = new Image();
    imageURL = URL.createObjectURL(file);
    image.setAttribute('src', imageURL);
    await new Promise((resolve, reject) => {
        image.onload = () => {
            try {
                const thumbnailWidth =
                    (image.width * THUMBNAIL_HEIGHT) / image.height;
                canvas.width = thumbnailWidth;
                canvas.height = THUMBNAIL_HEIGHT;
                canvasCTX.drawImage(
                    image,
                    0,
                    0,
                    thumbnailWidth,
                    THUMBNAIL_HEIGHT
                );
                image = null;
                clearTimeout(timeout);
                resolve(null);
            } catch (e) {
                const err = errorWithContext(
                    e,
                    `${CustomError.THUMBNAIL_GENERATION_FAILED} err: ${e}`
                );
                reject(err);
            }
        };
        timeout = setTimeout(
            () =>
                reject(
                    Error(
                        `wait time exceeded for format ${
                            file.name.split('.').slice(-1)[0]
                        }`
                    )
                ),
            WAIT_TIME_THUMBNAIL_GENERATION
        );
    });
    return canvas;
}

export async function generateVideoThumbnail(file: globalThis.File) {
    const canvas = document.createElement('canvas');
    const canvasCTX = canvas.getContext('2d');

    let videoURL = null;
    let timeout = null;

    await new Promise((resolve, reject) => {
        let video = document.createElement('video');
        videoURL = URL.createObjectURL(file);
        video.addEventListener('loadeddata', function () {
            try {
                if (!video) {
                    throw Error('video load failed');
                }
                const thumbnailWidth =
                    (video.videoWidth * THUMBNAIL_HEIGHT) / video.videoHeight;
                canvas.width = thumbnailWidth;
                canvas.height = THUMBNAIL_HEIGHT;
                canvasCTX.drawImage(
                    video,
                    0,
                    0,
                    thumbnailWidth,
                    THUMBNAIL_HEIGHT
                );
                video = null;
                clearTimeout(timeout);
                resolve(null);
            } catch (e) {
                const err = Error(
                    `${CustomError.THUMBNAIL_GENERATION_FAILED} err: ${e}`
                );
                logError(e, CustomError.THUMBNAIL_GENERATION_FAILED);
                reject(err);
            }
        });
        video.preload = 'metadata';
        video.src = videoURL;
        timeout = setTimeout(
            () =>
                reject(
                    Error(
                        `wait time exceeded for format ${
                            file.name.split('.').slice(-1)[0]
                        }`
                    )
                ),
            WAIT_TIME_THUMBNAIL_GENERATION
        );
    });
    return canvas;
}

async function thumbnailCanvasToBlob(canvas: HTMLCanvasElement) {
    let thumbnailBlob: Blob = null;
    let prevSize = Number.MAX_SAFE_INTEGER;
    let quality = 1;

    do {
        if (thumbnailBlob) {
            prevSize = thumbnailBlob.size;
        }
        thumbnailBlob = await new Promise((resolve) => {
            canvas.toBlob(
                function (blob) {
                    resolve(blob);
                },
                'image/jpeg',
                quality
            );
        });
        thumbnailBlob = thumbnailBlob ?? new Blob([]);
        quality /= 2;
    } while (
        thumbnailBlob.size > MAX_THUMBNAIL_SIZE &&
        percentageSizeDiff(thumbnailBlob.size, prevSize) >=
            MIN_COMPRESSION_PERCENTAGE_SIZE_DIFF
    );
    if (thumbnailBlob.size > MAX_THUMBNAIL_SIZE) {
        logError(
            Error('thumbnail_too_large'),
            'thumbnail greater than max limit'
        );
    }

    return thumbnailBlob;
}

function percentageSizeDiff(
    newThumbnailSize: number,
    oldThumbnailSize: number
) {
    return ((oldThumbnailSize - newThumbnailSize) * 100) / oldThumbnailSize;
}
