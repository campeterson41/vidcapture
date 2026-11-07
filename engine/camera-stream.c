// Bounded live camera transport. Preserve compressed pixels and capture timestamps.
#include <linux/videodev2.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <libavformat/avformat.h>
#include <libavutil/mathematics.h>

static volatile sig_atomic_t stopped;
static void stop(int sig) { (void)sig; stopped=1; }
static int control(int fd,unsigned long op,void *arg) {
 int result; do {result=ioctl(fd,op,arg);} while(result<0&&errno==EINTR&&!stopped);return result;
}
struct memory {void *data;size_t length;};
int main(int argc,char **argv) {
 int fd=-1,status=1,streaming=0;struct memory memory[4]={0};
 AVFormatContext *output=NULL;unsigned count=0;unsigned long sent=0,skipped=0;
 if(argc!=5||strncmp(argv[1],"/dev/video",10)||!argv[1][10]) {fprintf(stderr,"Usage: camera-stream /dev/videoN width height fps\n");return 2;}
 for(char *c=argv[1]+10;*c;c++)if(*c<'0'||*c>'9')return 2;
 int width=atoi(argv[2]),height=atoi(argv[3]),fps=atoi(argv[4]);
 if(width<32||width>3840||height<32||height>2160||fps!=30)return 2;
 signal(SIGTERM,stop);signal(SIGINT,stop);signal(SIGPIPE,SIG_IGN);
 fd=open(argv[1],O_RDWR|O_NONBLOCK|O_CLOEXEC|O_NOFOLLOW);if(fd<0){perror("camera open");goto done;}
 struct stat st;if(fstat(fd,&st)<0||!S_ISCHR(st.st_mode))goto done;
 struct v4l2_capability cap={0};if(control(fd,VIDIOC_QUERYCAP,&cap)<0)goto done;
 unsigned caps=cap.capabilities&V4L2_CAP_DEVICE_CAPS?cap.device_caps:cap.capabilities;
 if(!(caps&V4L2_CAP_VIDEO_CAPTURE)||!(caps&V4L2_CAP_STREAMING))goto done;
 struct v4l2_format format={.type=V4L2_BUF_TYPE_VIDEO_CAPTURE};
 format.fmt.pix.width=width;format.fmt.pix.height=height;format.fmt.pix.pixelformat=V4L2_PIX_FMT_MJPEG;
 if(control(fd,VIDIOC_S_FMT,&format)<0||format.fmt.pix.width!=(unsigned)width||format.fmt.pix.height!=(unsigned)height||format.fmt.pix.pixelformat!=V4L2_PIX_FMT_MJPEG)goto done;
 struct v4l2_streamparm rate={.type=V4L2_BUF_TYPE_VIDEO_CAPTURE};
 rate.parm.capture.timeperframe.numerator=1;rate.parm.capture.timeperframe.denominator=fps;
 if(control(fd,VIDIOC_S_PARM,&rate)<0)goto done;
 struct v4l2_requestbuffers request={.count=4,.type=V4L2_BUF_TYPE_VIDEO_CAPTURE,.memory=V4L2_MEMORY_MMAP};
 if(control(fd,VIDIOC_REQBUFS,&request)<0||request.count<2||request.count>4)goto done;
 count=request.count;
 for(unsigned i=0;i<count;i++) {
  struct v4l2_buffer buffer={.type=request.type,.memory=request.memory,.index=i};
  if(control(fd,VIDIOC_QUERYBUF,&buffer)<0)goto done;
  memory[i].length=buffer.length;memory[i].data=mmap(NULL,buffer.length,PROT_READ|PROT_WRITE,MAP_SHARED,fd,buffer.m.offset);
  if(memory[i].data==MAP_FAILED){memory[i].data=NULL;goto done;}
  if(control(fd,VIDIOC_QBUF,&buffer)<0)goto done;
 }
 if(avformat_alloc_output_context2(&output,NULL,"nut",NULL)<0)goto done;
 AVStream *video=avformat_new_stream(output,NULL);if(!video)goto done;
 video->time_base=(AVRational){1,1000000};video->avg_frame_rate=(AVRational){fps,1};
 video->codecpar->codec_type=AVMEDIA_TYPE_VIDEO;video->codecpar->codec_id=AV_CODEC_ID_MJPEG;
 video->codecpar->width=width;video->codecpar->height=height;
 if(avio_open(&output->pb,"pipe:1",AVIO_FLAG_WRITE)<0||avformat_write_header(output,NULL)<0)goto done;
 avio_flush(output->pb);
 if(control(fd,VIDIOC_STREAMON,&request.type)<0)goto done;
 streaming=1;
 while(!stopped) {
  struct pollfd ready={.fd=fd,.events=POLLIN};int result=poll(&ready,1,2000);
  if(result<0&&errno==EINTR)continue;
  if(result<=0||ready.revents&(POLLERR|POLLHUP|POLLNVAL)){fprintf(stderr,"Camera stopped delivering frames\n");goto done;}
  struct v4l2_buffer latest={.type=request.type,.memory=request.memory};
  if(control(fd,VIDIOC_DQBUF,&latest)<0){if(errno==EAGAIN)continue;goto done;}
  // After a slow consumer, discard queued old frames instead of replaying them.
  for(unsigned i=1;i<count;i++) {
   struct v4l2_buffer next={.type=request.type,.memory=request.memory};
   if(control(fd,VIDIOC_DQBUF,&next)<0){if(errno==EAGAIN)break;goto done;}
   if(control(fd,VIDIOC_QBUF,&latest)<0)goto done;
   latest=next;skipped++;
  }
  if(latest.index>=count||latest.bytesused>memory[latest.index].length)goto done;
  if(!(latest.flags&V4L2_BUF_FLAG_ERROR)&&latest.bytesused) {
   AVPacket packet={0};packet.data=memory[latest.index].data;packet.size=latest.bytesused;packet.stream_index=video->index;packet.flags=AV_PKT_FLAG_KEY;
   int64_t stamp=(int64_t)latest.timestamp.tv_sec*1000000+latest.timestamp.tv_usec;
   packet.pts=packet.dts=av_rescale_q(stamp,(AVRational){1,1000000},video->time_base);
   packet.duration=av_rescale_q(1,(AVRational){1,fps},video->time_base);
   if(av_write_frame(output,&packet)<0)goto done;
   avio_flush(output->pb);if(output->pb->error<0)goto done;sent++;
  }
  if(control(fd,VIDIOC_QBUF,&latest)<0)goto done;
 }
 status=0;
done:
 if(streaming){enum v4l2_buf_type type=V4L2_BUF_TYPE_VIDEO_CAPTURE;control(fd,VIDIOC_STREAMOFF,&type);}
 for(unsigned i=0;i<count;i++)if(memory[i].data)munmap(memory[i].data,memory[i].length);
 if(fd>=0)close(fd);
 if(output){if(output->pb)avio_closep(&output->pb);avformat_free_context(output);}
 fprintf(stderr,"Camera transport: sent=%lu skipped=%lu status=%d\n",sent,skipped,status);
 return status;
}
