package flash.filesystem {
    import __ruffle__.airReadFile;
    import __ruffle__.airWriteFile;

    import flash.events.EventDispatcher;
    import flash.utils.ByteArray;

    [API("661")]
    public class FileStream extends EventDispatcher {
        private var _file:File = null;
        private var _mode:String = null;
        private var _data:ByteArray = null;
        private var _position:uint = 0;

        public function FileStream() {
            super();
        }

        public function open(file:File, fileMode:String):void {
            if (file == null) {
                throw new Error("FileStream.open: file is null");
            }

            this.close();

            var data:ByteArray = airReadFile(file.url);
            if (data == null) {
                if (fileMode == FileMode.READ || fileMode == FileMode.UPDATE) {
                    throw new Error("FileStream.open: file does not exist: " + file.url);
                }
                data = new ByteArray();
            }

            this._file = file;
            this._mode = fileMode;
            this._data = data;
            this._position = 0;

            if (fileMode == FileMode.WRITE) {
                this._data.length = 0;
            } else if (fileMode == FileMode.APPEND) {
                this._position = this._data.length;
            }
        }

        public function close():void {
            if (this._file != null && this._data != null && this._mode != FileMode.READ) {
                airWriteFile(this._file.url, this._data);
            }

            this._file = null;
            this._mode = null;
            this._data = null;
            this._position = 0;
        }

        public function get bytesAvailable():uint {
            if (this._data == null) {
                return 0;
            }
            return this._data.length - this._position;
        }

        public function get position():Number {
            return this._position;
        }

        public function set position(value:Number):void {
            if (this._data == null) {
                return;
            }
            if (value < 0) {
                value = 0;
            }
            if (value > this._data.length) {
                value = this._data.length;
            }
            this._position = uint(value);
        }

        public function readBytes(bytes:ByteArray, offset:uint = 0, length:uint = 0):void {
            if (this._data == null) {
                throw new Error("FileStream.readBytes: stream is not open");
            }

            if (length == 0 || length > this.bytesAvailable) {
                length = this.bytesAvailable;
            }

            this._data.position = this._position;
            this._data.readBytes(bytes, offset, length);
            this._position = this._data.position;
        }

        public function writeBytes(bytes:ByteArray, offset:uint = 0, length:uint = 0):void {
            if (this._data == null) {
                throw new Error("FileStream.writeBytes: stream is not open");
            }

            this._data.position = this._position;
            this._data.writeBytes(bytes, offset, length);
            this._position = this._data.position;
        }

        public function writeUTFBytes(value:String):void {
            if (this._data == null) {
                throw new Error("FileStream.writeUTFBytes: stream is not open");
            }

            this._data.position = this._position;
            this._data.writeUTFBytes(value);
            this._position = this._data.position;
        }

        public function truncate():void {
            if (this._data == null) {
                return;
            }
            this._data.length = this._position;
        }
    }
}
